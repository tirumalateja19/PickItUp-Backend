import { Router } from "express";
import mongoose from "mongoose";
import userAuth from "../middleware/auth.middleware.js";
import verifyPartnerAccess from "../middleware/verifyPartnerAccess.middleware.js";
import { JobItem } from "../model/JobItem.model.js";
import { Job } from "../model/Job.model.js";
import upload from "../config/multer.js";
import { JobPhoto } from "../model/JobPhoto.model.js";
import pdfQueue from "../queues/pdfQueue.js";
import createAuditLog from "../utils/createAuditLog.js";
import { PodSlip } from "../model/PodSlip.model.js";
import cloudinary from "../config/cloudinary.js";
import { calcBox, calcTotals, MAX_PACKAGES } from "../utils/weight.js";
import { normalizeItemName } from "../utils/normalizeItemName.js";
const pickupRouter = Router();

//calculate
pickupRouter.post("/api/jobs/pickup/weight/calculate", userAuth, (req, res) => {
  try {
    const { packages } = req.body ?? {};

    if (!Array.isArray(packages) || packages.length === 0)
      return res.status(400).json({ message: "Send at least one box" });
    if (packages.length > MAX_PACKAGES)
      return res.status(400).json({ message: `Maximum ${MAX_PACKAGES} boxes` });

    const boxes = packages.map(calcBox);
    res.status(200).json({ packages: boxes, ...calcTotals(boxes) });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Something went wrong", error: error.message });
  }
});

//add details
pickupRouter.patch(
  "/api/jobs/pickup/:id/details",
  userAuth,
  verifyPartnerAccess,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).send("Invalid");
      }
      const {
        receiverName,
        receiverNumber,
        receiverAddress,
        packingStatus,
        status,
        receiverCity,
        receiverZipCode,
        receiverCountry,
      } = req.body ?? {};

      const updates = {};
      if (receiverName !== undefined) updates.receiverName = receiverName;
      if (receiverNumber !== undefined) updates.receiverNumber = receiverNumber;
      if (receiverAddress !== undefined)
        updates.receiverAddress = receiverAddress;
      if (packingStatus !== undefined) updates.packingStatus = packingStatus;
      if (status !== undefined) updates.status = status;
      if (receiverCity !== undefined) updates.receiverCity = receiverCity;
      if (receiverZipCode !== undefined)
        updates.receiverZipCode = receiverZipCode;
      if (receiverCountry !== undefined)
        updates.receiverCountry = receiverCountry;

      const jobData = await Job.findByIdAndUpdate(id, updates, {
        returnDocument: "after",
        runValidators: true,
      });

      if (!jobData) {
        return res.status(404).json({ message: "Job not found" });
      }
      res.status(200).json({ message: "Details added!!", jobData });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//save boxes
pickupRouter.put(
  "/api/jobs/pickup/:id/packages",
  userAuth,
  verifyPartnerAccess,
  async (req, res) => {
    try {
      const job = req.job;
      const { packages, packingStatus } = req.body;

      if (
        !Array.isArray(packages) ||
        packages.length < 1 ||
        packages.length > MAX_PACKAGES
      )
        return res
          .status(400)
          .json({ message: `1 to ${MAX_PACKAGES} boxes required` });

      const cleanPackages = [];
      const itemDocs = [];

      for (const p of packages) {
        const _id = mongoose.isValidObjectId(p._id)
          ? p._id
          : new mongoose.Types.ObjectId();
        const box = calcBox(p);

        if (box.actualWeight <= 0 || !box.length || !box.breadth || !box.height)
          return res
            .status(400)
            .json({ message: "Every box needs weight and dimensions" });

        if (!Array.isArray(p.items) || p.items.length === 0)
          return res
            .status(400)
            .json({ message: "Every box needs at least one item" });

        cleanPackages.push({ _id, ...box });

        const seenNames = new Set();

        for (const it of p.items) {
          const quantity = Number(it.quantity);
          if (
            !it.itemName?.trim() ||
            !Number.isInteger(quantity) ||
            quantity < 1
          )
            return res.status(400).json({ message: "Invalid item" });

          const itemName = normalizeItemName(it.itemName);
          const nameKey = itemName.toLowerCase();
          if (seenNames.has(nameKey))
            return res.status(400).json({
              message: `"${itemName}" is listed more than once in a box`,
            });
          seenNames.add(nameKey);

          itemDocs.push({
            itemName,
            quantity,
            fragile: !!it.fragile,
            jobId: job._id,
            packageId: _id,
          });
        }
      }

      job.packages = cleanPackages;
      job.numberOfPackages = String(cleanPackages.length);
      if (packingStatus !== undefined) job.packingStatus = packingStatus;
      await job.save();

      await JobItem.deleteMany({ jobId: job._id });
      const items = await JobItem.insertMany(itemDocs);

      res.status(200).json({
        message: "Package info saved",
        jobData: job,
        items,
        ...calcTotals(cleanPackages),
      });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//suggest items
pickupRouter.get(
  "/api/jobs/pickup/items/suggestions",
  userAuth,
  async (req, res) => {
    try {
      const names = await JobItem.distinct("itemName");
      const suggestions = [
        ...new Set(names.map(normalizeItemName).filter(Boolean)),
      ].sort((a, b) => a.localeCompare(b));
      res.status(200).json({ message: "Fetched successfully", suggestions });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//upload photo
pickupRouter.post(
  "/api/jobs/pickup/:id/photos",
  userAuth,
  verifyPartnerAccess,
  upload.single("photo"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { label } = req.body;

      const job = await Job.findById(id);
      if (!job) {
        return res.status(404).json({ message: "Job not found" });
      }
      if (job.locked) {
        return res
          .status(403)
          .json({ message: "Job is locked, cannot upload photos" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const validLabels = [
        "id_proof",
        "waybill",
        "invoice",
        "packed_box",
        "item_evidence",
        "payment_proof",
      ];
      if (!validLabels.includes(label)) {
        return res.status(400).json({ message: "Invalid label" });
      }

      if (label === "payment_proof") {
        const oldProofs = await JobPhoto.find({
          jobId: id,
          label: "payment_proof",
        });
        for (const p of oldProofs) {
          if (p.publicId) await cloudinary.uploader.destroy(p.publicId);
        }
        await JobPhoto.deleteMany({ jobId: id, label: "payment_proof" });
      }

      const photo = await JobPhoto.create({
        jobId: id,
        label,
        fileUrl: req.file.path,
        publicId: req.file.filename,
      });

      res.status(201).json({ message: "Photo uploaded successfully", photo });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//get photos
pickupRouter.get(
  "/api/jobs/pickup/:id/photos",
  userAuth,
  verifyPartnerAccess,
  async (req, res) => {
    try {
      const { id } = req.params;
      const photos = await JobPhoto.find({ jobId: id }).sort({ createdAt: 1 });
      res.status(200).json({ message: "Fetched successfully", photos });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//delete photos
pickupRouter.delete(
  "/api/jobs/pickup/:id/photos/:photoId",
  userAuth,
  verifyPartnerAccess,
  async (req, res) => {
    try {
      const { id, photoId } = req.params;

      const job = await Job.findById(id);
      if (!job) {
        return res.status(404).json({ message: "Job not found" });
      }
      if (job.locked) {
        return res
          .status(403)
          .json({ message: "Job is locked, cannot delete photos" });
      }

      const photo = await JobPhoto.findOne({ _id: photoId, jobId: id });
      if (!photo) {
        return res.status(404).json({ message: "Photo not found" });
      }

      if (photo.publicId) {
        await cloudinary.uploader.destroy(photo.publicId);
      }
      await JobPhoto.deleteOne({ _id: photoId });

      // Deleting the UPI proof voids the payment: ask for it again
      let paymentReset = false;
      if (
        photo.label === "payment_proof" &&
        job.paymentStatus === "paid" &&
        job.paymentMethod === "upi"
      ) {
        job.paymentStatus = "unpaid";
        job.paymentMethod = undefined;
        job.price = "0";
        await job.save();
        paymentReset = true;
      }

      res.status(200).json({
        message: paymentReset
          ? "Photo deleted. Payment reset to not paid"
          : "Photo deleted successfully",
        paymentReset,
        jobData: job,
      });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//payment
pickupRouter.put(
  "/api/jobs/pickup/:id/payment",
  userAuth,
  verifyPartnerAccess,
  async (req, res) => {
    try {
      const job = req.job; // set by verifyPartnerAccess
      if (job.locked)
        return res
          .status(403)
          .json({ message: "Job is locked, cannot edit payment" });
      const { paymentStatus, paymentMethod, price } = req.body ?? {};

      if (!["paid", "unpaid"].includes(paymentStatus))
        return res.status(400).json({ message: "Select paid or not paid" });

      if (paymentStatus === "unpaid") {
        job.paymentStatus = "unpaid";
        job.paymentMethod = undefined;
        job.price = "0";
      } else {
        if (!["cash", "upi"].includes(paymentMethod))
          return res.status(400).json({ message: "Select cash or UPI" });

        const amount = Math.round(Number(price) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0)
          return res.status(400).json({ message: "Enter the amount received" });

        if (paymentMethod === "upi") {
          const proof = await JobPhoto.findOne({
            jobId: job._id,
            label: "payment_proof",
          });
          if (!proof)
            return res
              .status(400)
              .json({ message: "Add the UPI payment photo first" });
        }

        job.paymentStatus = "paid";
        job.paymentMethod = paymentMethod;
        job.price = String(amount);
      }

      await job.save();

      // proof only makes sense for UPI: remove a stale one if the method changed
      if (!(job.paymentStatus === "paid" && job.paymentMethod === "upi")) {
        const stale = await JobPhoto.find({
          jobId: job._id,
          label: "payment_proof",
        });
        for (const p of stale) {
          if (p.publicId) await cloudinary.uploader.destroy(p.publicId);
        }
        if (stale.length)
          await JobPhoto.deleteMany({ jobId: job._id, label: "payment_proof" });
      }

      res.status(200).json({ message: "Payment saved", jobData: job });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//generating pod-slip
pickupRouter.post(
  "/api/jobs/pickup/:id/submit",
  userAuth,
  verifyPartnerAccess,
  async (req, res) => {
    try {
      const { id } = req.params;

      const jobData = await Job.findById(id);
      if (!jobData) {
        return res.status(404).json({ message: "Job not found" });
      }
      if (
        !jobData.receiverName ||
        !jobData.receiverAddress ||
        !jobData.receiverNumber ||
        !jobData.receiverCity ||
        !jobData.receiverZipCode
      ) {
        return res
          .status(400)
          .json({ message: "Please add receiver details before proceeding" });
      }

      await Job.findByIdAndUpdate(id, {
        status: "AtOffice",
        podSlipStatus: "pending",
      });

      await pdfQueue.add(
        "generate-pod-slip",
        {
          jobId: id,
          generatedById: req.user.id,
          generatedByUsername: req.user.userName,
          actorRole: req.user.role,
        },
        {
          jobId: `pod-slip-${id}`,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );

      res.status(200).json({ message: "Pod slip generating" });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

export default pickupRouter;
