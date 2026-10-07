import connectDB from "../src/config/db.js";
import Admin from "../src/model/Admin.model.js";
import bcrypt from "bcrypt";

const seedAdmin = async () => {
  await connectDB();
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  const existing = await Admin.findOne({
    userName: process.env.ADMIN_USERNAME,
  });
  if (existing) {
    console.log("Admin already exists");
    process.exit(0);
  }
  const admin = new Admin({
    userName: process.env.ADMIN_USERNAME,
    password: passwordHash,
    contactNumber: process.env.CONTACT_NUMBER,
  });
  await admin.save();
  console.log("Admin data seeded..");
  process.exit(0);
};
seedAdmin();
