// One-off cleanup: finds Cloudinary files that no database record points at.
//
//   node scripts/cleanupOrphans.js                     -> dry run, only lists what it would delete
//   node scripts/cleanupOrphans.js --delete            -> actually deletes (cannot be undone)
//   node scripts/cleanupOrphans.js --min-age-hours=48  -> ignore files newer than 48h (default 24)
//
// Safety:
//  - dry run by default
//  - files newer than --min-age-hours are skipped, so an upload that has reached
//    Cloudinary but is still being saved to the database is never touched
//  - a category is skipped if the database returns no records at all, which
//    would mean the script is pointed at the wrong database
import "dotenv/config";
import mongoose from "mongoose";
import cloudinary from "../config/cloudinary.js";
import { PodSlip } from "../model/PodSlip.model.js";
import { JobPhoto } from "../model/JobPhoto.model.js";

const args = process.argv.slice(2);
const DO_DELETE = args.includes("--delete");
const minAgeArg = args.find((a) => a.startsWith("--min-age-hours="));
const MIN_AGE_HOURS = minAgeArg ? Number(minAgeArg.split("=")[1]) : 24;
const CUTOFF = Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000;

const PDF_PREFIX = "pickitup/podslips/";

// Same idea as podNaming.js: slips from before the naming change only stored the URL
const publicIdFromUrl = (url = "") => {
  const match = url.match(/\/raw\/upload\/(?:v\d+\/)?(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

// Images: .../image/upload/v123/folder/name.jpg -> folder/name (no extension)
const photoPublicIdFromUrl = (url = "") => {
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[A-Za-z0-9]+)?$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const formatBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const listAll = async (resourceType, prefix) => {
  const found = [];
  let nextCursor;
  do {
    const res = await cloudinary.api.resources({
      type: "upload",
      resource_type: resourceType,
      prefix,
      max_results: 500,
      next_cursor: nextCursor,
    });
    found.push(...res.resources);
    nextCursor = res.next_cursor;
  } while (nextCursor);
  return found;
};

const findOrphans = async (resourceType, prefixes, referenced) => {
  const orphans = new Map();
  for (const prefix of prefixes) {
    const resources = await listAll(resourceType, prefix);
    console.log(`  scanned ${resources.length} file(s) under "${prefix}"`);
    for (const r of resources) {
      if (referenced.has(r.public_id)) continue;
      if (new Date(r.created_at).getTime() > CUTOFF) continue; // might still be saving
      orphans.set(r.public_id, r);
    }
  }
  return [...orphans.values()];
};

const report = (label, orphans) => {
  const bytes = orphans.reduce((sum, o) => sum + (o.bytes || 0), 0);
  console.log(
    `\n${label}: ${orphans.length} orphaned file(s), ${formatBytes(bytes)}`,
  );
  orphans.forEach((o) => console.log(`  ${o.public_id}  (${o.created_at})`));
};

const deleteAll = async (orphans, resourceType) => {
  for (let i = 0; i < orphans.length; i += 100) {
    const batch = orphans.slice(i, i + 100).map((o) => o.public_id);
    const res = await cloudinary.api.delete_resources(batch, {
      resource_type: resourceType,
      type: "upload",
      invalidate: true,
    });
    const deleted = Object.values(res.deleted).filter(
      (v) => v === "deleted",
    ).length;
    console.log(`  deleted ${deleted} of ${batch.length} in this batch`);
  }
};

const main = async () => {
  // Use whatever env var your server uses for the connection string
  const uri = process.env.DB_URL || process.env.MONGO_URI;
  if (!uri) throw new Error("Set MONGODB_URI (or MONGO_URI) in your .env");
  await mongoose.connect(uri);

  console.log(
    DO_DELETE
      ? `DELETE MODE (files older than ${MIN_AGE_HOURS}h)`
      : `DRY RUN (files older than ${MIN_AGE_HOURS}h) - nothing will be deleted`,
  );

  // ---- PDFs (stored as raw files) ----
  console.log("\nPOD slip PDFs");
  const slips = await PodSlip.find({}, "publicId pdfUrl").lean();
  let pdfOrphans = [];
  if (slips.length === 0) {
    console.log("  no PodSlip records found, skipping (wrong database?)");
  } else {
    const referencedPdfs = new Set(
      slips.map((s) => s.publicId || publicIdFromUrl(s.pdfUrl)).filter(Boolean),
    );
    pdfOrphans = await findOrphans("raw", [PDF_PREFIX], referencedPdfs);
    report("PDFs", pdfOrphans);
  }

  // ---- Photos (folders are read off the stored publicIds) ----
  console.log("\nPhotos");
  const photos = await JobPhoto.find({}, "publicId fileUrl").lean();
  let photoOrphans = [];
  let photosSafeToDelete = true;
  if (photos.length === 0) {
    console.log("  no JobPhoto records found, skipping (wrong database?)");
  } else {
    // Older records may have no publicId, so fall back to reading it off the URL
    const photoIds = photos.map(
      (p) => p.publicId || photoPublicIdFromUrl(p.fileUrl),
    );
    const unresolved = photoIds.filter((id) => !id).length;
    if (unresolved > 0) {
      photosSafeToDelete = false;
      console.log(
        `  WARNING: ${unresolved} photo record(s) have no usable id. Photos will be listed but NOT deleted.`,
      );
    }
    const referencedPhotos = new Set(photoIds.filter(Boolean));
    const folders = [
      ...new Set(
        photoIds
          .filter(Boolean)
          .map((id) => id.split("/").slice(0, -1).join("/"))
          .filter(Boolean),
      ),
    ].map((f) => `${f}/`);

    if (folders.length === 0) {
      console.log("  photos are not stored in a folder, skipping for safety");
    } else {
      photoOrphans = await findOrphans("image", folders, referencedPhotos);
      report("Photos", photoOrphans);
    }
  }

  if (DO_DELETE) {
    if (pdfOrphans.length) {
      console.log("\nDeleting PDFs...");
      await deleteAll(pdfOrphans, "raw");
    }
    if (photoOrphans.length && photosSafeToDelete) {
      console.log("\nDeleting photos...");
      await deleteAll(photoOrphans, "image");
    } else if (photoOrphans.length) {
      console.log("\nSkipping photo deletion (some photo records have no usable id).");
    }
    console.log("\nDone.");
  } else {
    console.log("\nDry run finished. Re-run with --delete to remove these files.");
  }

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
