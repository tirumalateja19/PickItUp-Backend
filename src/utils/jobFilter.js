// The filter used by the dashboard job list, shared with the CSV export so
// "export what you see" is always true. Reads: status, assignedToId,
// fromDate, toDate, clientName.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const buildJobFilter = (query = {}) => {
  const { status, assignedToId, fromDate, toDate, clientName } = query;

  const filter = { isArchived: { $ne: true } };

  if (status === "Open") {
    filter.status = { $in: ["Created", "Assigned", "PickedUp", "AtOffice"] };
  } else if (status === "Completed") {
    filter.status = { $in: ["Dispatched"] };
  } else if (status) {
    filter.status = status;
  }

  if (assignedToId) filter.assignedToId = assignedToId;

  if (clientName) {
    filter.clientName = { $regex: escapeRegex(clientName), $options: "i" };
  }

  if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = new Date(fromDate);
    if (toDate) {
      // include the whole "to" day, not just its first millisecond
      const end = new Date(toDate);
      end.setUTCHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  return filter;
};
