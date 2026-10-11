import { Router } from "express";
import userAuth from "../middleware/auth.middleware.js";
import isAdmin from "../middleware/isAdmin.middleware.js";
import { Job } from "../model/Job.model.js";
import mongoose from "mongoose";
import Partner from "../model/Partner.model.js";
import createAuditLog from "../utils/createAuditLog.js";
import { JobItem } from "../model/JobItem.model.js";
import verifyPartnerAccess from "../middleware/verifyPartnerAccess.middleware.js";
import { PodSlip } from "../model/PodSlip.model.js";
import { Shipment } from "../model/Shipment.model.js";
import pdfQueue from "../queues/pdfQueue.js";
const jobRouter = Router();
import { buildJobFilter } from "../utils/jobFilter.js";
import { toCsv, formatDateTime } from "../utils/csv.js";

//create new-job
jobRouter.post("/api/jobs/new-job", userAuth, isAdmin, async (req, res) => {
  try {
    const {
      clientName,
      clientNumber,
      clientAddress,
      clientCity,
      approxWeight,
      networkName,
      mapLink,
      partnerId,
    } = req.body;

    if (
      !clientName ||
      !clientNumber ||
      !clientAddress ||
      !clientCity ||
      !approxWeight ||
      !networkName ||
      !partnerId
    ) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const link = typeof mapLink === "string" ? mapLink.trim() : "";
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      return res
        .status(400)
        .json({ message: "Map link must be a valid http(s) URL" });
    }

    if (!mongoose.Types.ObjectId.isValid(partnerId)) {
      return res.status(400).json({ message: "Invalid partner" });
    }
    const partnerData = await Partner.findById(partnerId);
    if (!partnerData) {
      return res.status(404).json({ message: "Partner not found" });
    }
    if (partnerData.isDeactivated) {
      return res
        .status(406)
        .json({ message: "Cannot assign, Partner deactivated!" });
    }

    const job = new Job({
      clientName,
      clientNumber,
      clientAddress,
      clientCity,
      approxWeight,
      networkName,
      mapLink: link,
      scheduledTime: new Date(),
      assignedToId: partnerData._id,
      assignedToRole: "partner",
      assignedTo: partnerData.userName,
      status: "Assigned",
    });
    await job.save();

    createAuditLog({
      jobId: job._id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.userName,
      action: "jobCreated",
    });
    createAuditLog({
      jobId: job._id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.userName,
      action: "jobAssigned",
      previousStatus: "Created",
      newStatus: "Assigned",
    });

    res.status(201).json({
      message: "Job created and assigned successfully",
      jobData: job,
      partnerPhone: partnerData.contactNumber,
    });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

//all jobs
jobRouter.get("/api/jobs", userAuth, isAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter = buildJobFilter(req.query);

    const [totalJobs, totalCount] = await Promise.all([
      Job.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Job.countDocuments(filter),
    ]);

    res.status(200).json({
      message: "Fetched Successfully",
      totalJobs,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      currentPage: page,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const MAX_EXPORT_ROWS = 10000;

const sum = (packages, field) =>
  (packages || []).reduce((total, p) => total + (Number(p[field]) || 0), 0);
const kg = (n) => (n ? n.toFixed(2) : "");

const EXPORT_COLUMNS = [
  { header: "Created", value: (j) => formatDateTime(j.createdAt) },
  { header: "Job ID", value: (j) => j._id },
  { header: "Client Name", value: (j) => j.clientName },
  { header: "Client Number", value: (j) => j.clientNumber },
  { header: "Client Address", value: (j) => j.clientAddress },
  { header: "Client Area", value: (j) => j.clientCity },
  { header: "Partner", value: (j) => j.assignedTo },
  { header: "Network", value: (j) => j.networkName },
  { header: "Status", value: (j) => j.status },
  { header: "Locked", value: (j) => (j.locked ? "Yes" : "No") },
  { header: "Receiver Name", value: (j) => j.receiverName },
  { header: "Receiver Number", value: (j) => j.receiverNumber },
  { header: "Receiver Address", value: (j) => j.receiverAddress },
  { header: "Receiver City", value: (j) => j.receiverCity },
  { header: "Receiver Zip", value: (j) => j.receiverZipCode },
  { header: "Receiver Country", value: (j) => j.receiverCountry },
  { header: "Boxes", value: (j) => (j.packages || []).length || "" },
  {
    header: "Actual Weight (kg)",
    value: (j) => kg(sum(j.packages, "actualWeight")),
  },
  {
    header: "Volumetric Weight (kg)",
    value: (j) => kg(sum(j.packages, "volWeight")),
  },
  {
    header: "Chargeable Weight (kg)",
    value: (j) => kg(sum(j.packages, "weight")),
  },
  { header: "Price", value: (j) => j.price },
  { header: "Payment Status", value: (j) => j.paymentStatus },
  { header: "Payment Method", value: (j) => j.paymentMethod },
  { header: "Packing Status", value: (j) => j.packingStatus },
  { header: "Dispatched At", value: (j) => j.dispatchedAt },
];

//csv 
jobRouter.get("/api/jobs/export/csv", userAuth, isAdmin, async (req, res) => {
  try {
    const jobs = await Job.find(buildJobFilter(req.query))
      .sort({ createdAt: -1 })
      .limit(MAX_EXPORT_ROWS)
      .lean();

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="jobs-${today}.csv"`,
    );
    res.status(200).send(toCsv(EXPORT_COLUMNS, jobs));
  } catch (err) {
    res
      .status(400)
      .json({ message: "Failed to export jobs", error: err.message });
  }
});

//assign-partner
jobRouter.patch("/api/jobs/:id/assign", userAuth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params; //jobId
    const { partnerId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send("Invalid job");
    }
    if (!mongoose.Types.ObjectId.isValid(partnerId)) {
      return res.status(400).send("Invalid partner");
    }
    const partnerData = await Partner.findById(partnerId);
    if (!partnerData) {
      return res.status(404).json({ message: "Partner not found" });
    }
    if (partnerData.isDeactivated) {
      return res
        .status(406)
        .json({ message: "Cannot assign, Partner deactivated!" });
    }
    const existingJob = await Job.findById(id);
    if (
      !["Created", "Assigned"].includes(existingJob.status) ||
      existingJob.locked
    ) {
      return res
        .status(409)
        .json({ message: "This job can no longer be reassigned" });
    }
    const jobData = await Job.findByIdAndUpdate(
      id,
      {
        assignedToId: partnerId,
        assignedToRole: "partner",
        assignedTo: partnerData.userName,
        status: "Assigned",
      },
      { returnDocument: "after" },
    );
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }
    createAuditLog({
      jobId: id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.userName,
      action: "jobAssigned",
      previousStatus: existingJob.status,
      newStatus: "Assigned",
    });

    res.status(200).json({
      message: "Job Assigned Successfully",
      jobData,
      partnerPhone: partnerData.contactNumber,
    });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Something went wrong", error: error.message });
  }
});

//partner-contact
jobRouter.get(
  "/api/jobs/:id/partner-contact",
  userAuth,
  isAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid job" });
      }
      const job = await Job.findById(id).select("assignedToId");
      if (!job || !job.assignedToId) {
        return res.status(404).json({ message: "Job or partner not found" });
      }
      const partner = await Partner.findById(job.assignedToId).select(
        "contactNumber",
      );
      if (!partner) {
        return res.status(404).json({ message: "Partner not found" });
      }
      res.status(200).json({ partnerPhone: partner.contactNumber });
    } catch (err) {
      res.status(400).json({ message: "Something went wrong" });
    }
  },
);

const EDITABLE_JOB_FIELDS = [
  "clientName",
  "clientNumber",
  "clientAddress",
  "clientCity",
  "approxWeight",
  "networkName",
  "mapLink",
];

//edit job-data
jobRouter.patch("/api/jobs/:id", userAuth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { partnerId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid job" });
    }

    const job = await Job.findById(id);
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (job.locked || job.cancelled || job.isArchived) {
      return res
        .status(403)
        .json({ message: "This job can no longer be edited" });
    }

    // Partner change: validate everything before touching the document
    let newPartner = null;
    if (
      partnerId !== undefined &&
      String(partnerId) !== String(job.assignedToId)
    ) {
      if (!["Created", "Assigned"].includes(job.status)) {
        return res.status(409).json({
          message: "The partner can only be changed before pickup",
        });
      }
      if (!mongoose.Types.ObjectId.isValid(partnerId)) {
        return res.status(400).json({ message: "Invalid partner" });
      }
      newPartner = await Partner.findById(partnerId);
      if (!newPartner) {
        return res.status(404).json({ message: "Partner not found" });
      }
      if (newPartner.isDeactivated) {
        return res
          .status(406)
          .json({ message: "Cannot assign, Partner deactivated!" });
      }
    }

    for (const field of EDITABLE_JOB_FIELDS) {
      const raw = req.body[field];
      if (raw === undefined) continue; // field not sent, leave as is
      if (typeof raw !== "string") {
        return res.status(400).json({ message: `${field} must be text` });
      }
      const value = raw.trim();
      if (field !== "mapLink" && !value) {
        return res.status(400).json({ message: `${field} cannot be empty` });
      }
      if (field === "mapLink" && value && !/^https?:\/\/\S+$/i.test(value)) {
        return res
          .status(400)
          .json({ message: "Map link must be a valid http(s) URL" });
      }
      job[field] = value;
    }

    const detailsChanged = EDITABLE_JOB_FIELDS.some((f) => job.isModified(f));
    const previousStatus = job.status;

    if (newPartner) {
      job.assignedToId = newPartner._id;
      job.assignedToRole = "partner";
      job.assignedTo = newPartner.userName;
      job.status = "Assigned";
    }

    // nothing actually changed, so skip the save (avoids a pointless updatedAt bump)
    if (!job.isModified()) {
      return res
        .status(200)
        .json({ message: "No changes", jobData: job, partnerPhone: null });
    }

    await job.save(); // runs schema validators (e.g. clientNumber maxLength)

    const actor = {
      jobId: job._id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.userName,
    };
    if (detailsChanged) {
      createAuditLog({ ...actor, action: "jobEdited" });
    }
    if (newPartner) {
      createAuditLog({
        ...actor,
        action: "jobAssigned",
        previousStatus,
        newStatus: "Assigned",
      });
    }

    res.status(200).json({
      message: newPartner
        ? "Job updated and reassigned successfully"
        : "Job updated successfully",
      jobData: job,
      // only set when the partner changed, so the frontend knows to offer WhatsApp
      partnerPhone: newPartner ? newPartner.contactNumber : null,
    });
  } catch (err) {
    res
      .status(400)
      .json({ message: "Something went wrong", error: err.message });
  }
});

//self-assign
jobRouter.patch(
  "/api/jobs/:id/self-assign",
  userAuth,
  isAdmin,
  async (req, res) => {
    try {
      const adminId = req.user.id; //adminId
      const adminName = req.user.userName;
      const { id } = req.params; //jobId

      if (!mongoose.Types.ObjectId.isValid(adminId)) {
        return res.status(400).send("Invalid admin");
      }
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).send("Invalid job");
      }

      const existingJob = await Job.findById(id);
      if (!existingJob) {
        return res.status(404).json({ message: "Job not found" });
      }

      const jobData = await Job.findByIdAndUpdate(
        id,
        {
          assignedToId: adminId,
          assignedToRole: "admin",
          assignedTo: adminName,
          status: "Assigned",
        },
        { returnDocument: "after" },
      );

      if (!jobData) {
        return res.status(404).json({ message: "Job not found" });
      }
      createAuditLog({
        jobId: id,
        actorId: req.user.id,
        actorRole: req.user.role,
        actorName: req.user.userName,
        action: "jobAssigned",
        previousStatus: existingJob.status,
        newStatus: "assigned",
      });

      res.status(200).json({ message: "Job Assigned Successfully", jobData });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//current job
jobRouter.get("/api/jobs/:id", userAuth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params; //jobId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send("Invalid");
    }
    const jobData = await Job.findById(id);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }
    const items = await JobItem.find({ jobId: id });
    res.status(200).json({ message: "Job Fetch Successfull", jobData, items });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Something went wrong", error: error.message });
  }
});

//change-status
jobRouter.patch("/api/jobs/:id/status", userAuth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params; //job_id
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send("Invalid job");
    }
    const updateJob = await Job.findByIdAndUpdate(
      id,
      { status: status },
      { runValidators: true, returnDocument: "after" },
    );
    if (!updateJob) {
      return res.status(400).json({ message: "Job not found" });
    }

    res.status(200).json({ message: "Status Updated", jobData: updateJob });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Something went wrong", error: error.message });
  }
});

//lock-job
jobRouter.patch("/api/jobs/:id/lock", userAuth, isAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { lockedReason } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send("Invalid");
    }
    const jobData = await Job.findById(id);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (jobData.assignedToRole === "admin") {
      return res.status(406).json({ message: "Cannot lock your job" });
    }
    if (jobData.locked) {
      return res.status(200).json({ message: "Job's already locked", jobData });
    }
    const lockedJob = await Job.findByIdAndUpdate(
      id,
      { locked: true, lockedAt: new Date(), lockedReason: lockedReason },
      { returnDocument: "after" },
    );
    createAuditLog({
      jobId: id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.userName,
      action: "jobLocked",
      previousStatus: undefined, // or "unlocked" if you decide to track it as a pseudo-status
      newStatus: undefined, // same
    });
    res
      .status(200)
      .json({ message: "Job locked successfully", jobData: lockedJob });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Something went wrong", error: error.message });
  }
});

//unlock-job
jobRouter.patch("/api/jobs/:id/unlock", userAuth, isAdmin, async (req, res) => {
  try {
    const id = req.params.id; //job id
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send("Invalid");
    }
    const jobData = await Job.findById(id);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (jobData.locked === false) {
      return res
        .status(200)
        .json({ message: "Job's already unLocked", jobData });
    }
    if (jobData.cancelled) {
      return res.status(400).json({
        message:
          "This job was cancelled and cannot be unlocked. Create a new job instead.",
      });
    }
    const unLockedJob = await Job.findByIdAndUpdate(
      id,
      {
        locked: false,
        unlockedBy: req.user.id,
        unlockedByAdminName: req.user.userName,
      },
      { returnDocument: "after" },
    );
    createAuditLog({
      jobId: id,
      actorId: req.user.id,
      actorRole: req.user.role,
      actorName: req.user.userName,
      action: "jobUnlocked",
    });
    res
      .status(200)
      .json({ message: "Job unLocked successfully", jobData: unLockedJob });
  } catch (error) {
    res
      .status(400)
      .json({ message: "Something went wrong", error: error.message });
  }
});

//get pod-slip
jobRouter.get(
  "/api/jobs/:id/pod-slip",
  userAuth,
  verifyPartnerAccess,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).send("Invalid job id");
      }

      const jobData = await Job.findById(id).select("podSlipStatus");
      if (!jobData) {
        return res.status(404).json({ message: "Job not found" });
      }

      const podSlip = await PodSlip.findOne({ jobId: id }).sort({
        createdAt: -1,
      });

      if (!podSlip) {
        return res.status(200).json({
          message: "Pod slip not generated yet",
          podSlipStatus: jobData.podSlipStatus,
          podSlip: null,
        });
      }

      res.status(200).json({
        message: "Pod slip fetched",
        podSlipStatus: jobData.podSlipStatus,
        podSlip,
      });
    } catch (error) {
      res
        .status(400)
        .json({ message: "Something went wrong", error: error.message });
    }
  },
);

//generate pod-slip - admin
jobRouter.post("/api/jobs/:id/submit", userAuth, isAdmin, async (req, res) => {
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
});

export default jobRouter;
