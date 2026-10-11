// Date and time in the business timezone (set BUSINESS_TZ, e.g. Asia/Kolkata).
export const formatDateTime = (date) => {
  if (!date) return "";
  const format = (timeZone) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(date))
        .map((p) => [p.type, p.value]),
    );

  let p;
  try {
    p = format(process.env.BUSINESS_TZ || "UTC");
  } catch {
    p = format("UTC");
  }
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

// Spreadsheet apps run text that starts with = + - @ as a formula. Client names
// and addresses are typed by people, so defuse those, but leave plain phone
// numbers such as +44 20 7946 0958 alone.
const needsGuard = (s) =>
  /^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s);

const cell = (value) => {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (needsGuard(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// columns: [{ header, value: (row) => ... }]
// The leading BOM makes Excel read the file as UTF-8 (names, the ₹ sign).
export const toCsv = (columns, rows) => {
  const header = columns.map((c) => cell(c.header)).join(",");
  const lines = rows.map((row) =>
    columns.map((c) => cell(c.value(row))).join(","),
  );
  return "\uFEFF" + [header, ...lines].join("\r\n");
};
