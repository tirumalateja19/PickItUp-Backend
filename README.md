# PickItUp Courier App — Backend

A MERN-stack courier management system backend built with Node.js, Express, and MongoDB. Supports two user roles (Admin and Partner) with full job lifecycle management — from job creation and assignment through pickup, box-wise package details, payment capture, POD PDF generation, and dispatch.

## Tech Stack

| **Category** | **Technology** |
| :--- | :--- |
| **Runtime** | [![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)](https://expressjs.com/) |
| **Database** | [![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/) [![Mongoose](https://img.shields.io/badge/Mongoose-ODM-880000?logo=mongoose&logoColor=white)](https://mongoosejs.com/) |
| **Auth & Security** | [![JWT](https://img.shields.io/badge/JWT-httpOnly_Cookies-000000?logo=jsonwebtokens&logoColor=white)](https://jwt.io/) |
| **File Storage** | [![Cloudinary](https://img.shields.io/badge/Cloudinary-Media_%26_PDFs-3448C5?logo=cloudinary&logoColor=white)](https://cloudinary.com/) [![Multer](https://img.shields.io/badge/Multer-File_Uploads-FF6C37?logo=npm&logoColor=white)](https://www.npmjs.com/package/multer) |
| **Background Queue** | [![BullMQ](https://img.shields.io/badge/BullMQ-Job_Queue-E72C41?logo=redis&logoColor=white)](https://docs.bullmq.io/) [![Upstash](https://img.shields.io/badge/Upstash-Serverless_Redis-00E9A3?logo=upstash&logoColor=white)](https://upstash.com/) |
| **PDF Generation** | [![Puppeteer](https://img.shields.io/badge/Puppeteer-HTML_to_PDF-40B5A4?logo=puppeteer&logoColor=white)](https://pptr.dev/) |

## Architecture Overview

- Two roles — **Admin** and **Partner** — each with separate login endpoints, stored in separate Mongoose models.
- Role identity is carried in the JWT payload (`role: "admin" | "partner"`), not stored redundantly on documents.
- Heavy/slow work (PDF generation) is offloaded to a BullMQ queue + worker, decoupled from the request/response cycle — routes enqueue jobs and respond immediately; the worker processes them in the background using Puppeteer + Cloudinary.
- POD slips are **content-aware**: a SHA-256 `sourceHash` of every field that feeds the template decides whether a regeneration is actually needed, so unchanged jobs never re-render.
- Every meaningful state change (job created, edited, assigned/reassigned, locked/unlocked, dispatched, pod slip generated, partner deactivated/activated, items/photos/payment edited) is recorded in an append-only `AuditLog` collection for traceability and dispute resolution. Audit writes are fire-and-forget.

## Project Structure

```
src/
├── config/          # DB, Redis, Cloudinary, Multer/Cloudinary storage setup
├── middleware/      # Auth, role guards, lock/assignment checks
├── model/           # Mongoose schemas
├── routes/          # Express route definitions
├── queues/          # BullMQ queue definitions
├── workers/         # BullMQ worker(s) — PDF generation
├── utils/           # Shared helpers (audit logging, template rendering, weight calculation)
└── index.js         # App entry point

uploads/
└── templates/       # HTML template used for PDF generation (pod-slip)

scripts/
└── seedAdmin.js     # One-off script to seed the first admin account
```

## Architecture Notes

<img width="994" height="1496" alt="image" src="https://github.com/user-attachments/assets/4238e1f5-3d57-4c12-a19a-83f37c3a7315" />

## Data Models

| Model | Purpose |
|---|---|
| `Admin` | Admin accounts |
| `Partner` | Delivery partner accounts, includes `isDeactivated` flag |
| `Job` | Core courier job — client & receiver details, `packages` array (L/B/H + weight per box), payment status, status, lock state, `podSlipStatus` |
| `JobItem` | Individual items, scoped to a box within a job's package |
| `JobPhoto` | Labelled photos (id proof, waybill, packed box, invoice, item evidence, `payment_proof`) tied to a job, includes Cloudinary `publicId` for deletion |
| `PodSlip` | Generated proof-of-delivery PDF metadata — URL, Cloudinary `publicId`, `sourceHash` (content hash used for change detection), and `pdfHash` (SHA-256 of the PDF, reserved for future dedup) |
| `Shipment` | Carrier/tracking info once a job is dispatched |
| `AuditLog` | Append-only event log for every significant action |

**Conventions**

- Job status enum (PascalCase): `Created`, `Assigned`, `PickedUp`, `AtOffice`, `Dispatched`, `Cancelled`
- `podSlipStatus`: `idle` | `pending` | `ready` | `unchanged` | `failed`

## Authentication & Authorization

- `POST /api/auth/login` — Admin login
- `POST /api/partner/login` — Partner login
- JWT stored in an httpOnly, secure cookie
- `userAuth` middleware — verifies JWT, attaches `req.user`
- `isAdmin` middleware — restricts a route to admin role only
- `verifyPartnerAccess` middleware — allows admin through for shared routes; for partners, verifies the job is assigned to them **and** not locked

## Core Job Lifecycle

1. **Admin creates a job** (`POST /api/jobs/new-job`), choosing the partner to assign at creation time. A WhatsApp click-to-chat message (`wa.me`) can then be sent to the partner from the frontend; an optional admin-pasted map link is included when provided.
2. **Admin can edit the job's creation fields** through an admin-only PATCH route, and can **reassign** the partner — but only before pickup.
3. **Partner (or admin) fills in details** as they go — receiver info, weight, dimensions, boxes, items, photos, payment — all save-as-you-go via PATCH/POST routes.
4. **Partner (or admin) submits** (`POST /api/jobs/pickup/:id/submit`) — requires receiver details and at least one box; enqueues a single `generate-pod-slip` job, which renders the POD slip (with invoice and box-wise item details) as page 1 followed by each uploaded photo as its own page.
5. **Admin records shipment** (`POST /api/jobs/:id/shipment`) — logs carrier/tracking info, marks job dispatched.
6. Job can be **manually locked/unlocked** by admin at any point (with reason tracking). While locked, partners cannot edit anything, and nobody — admin included — can add or delete photos or change payment. Admin keeps the lock/unlock override.

## Package Info (Box-wise)

- Each job has a `packages` array; every box carries length, breadth, height, and weight, with its own items (`JobItem`).
- **Weights are computed server-side** (`utils/weight.js`). Volumetric weight uses a divisor of **5000** for centimetres and **305** for inches, based on the selected measurement unit. Rounding: below 20 kg rounds up to the nearest 0.5 kg; 20 kg and above rounds up to the next whole kg. `approxWeight` remains a separate field.
- Item names must be **unique per box** (not per job) and are capitalised consistently on save.
- The price is entered manually and lives in the payment section, not in package info.

## Payment

- A job is **Paid** or **Not paid**. If paid, the method is **Cash** or **UPI**.
- UPI requires a proof image (camera or gallery; screenshots allowed), stored as a `JobPhoto` with label `payment_proof` and included in the final PDF.
- Not paid defaults the price to 0.
- Deleting the UPI proof resets the job to not paid, so payment is asked for again.
- Payment changes and proof upload/delete are blocked once the job is locked.

## Photos

- Photos are uploaded via Multer to Cloudinary and stored as `JobPhoto` documents with a label.
- A GET endpoint returns photos grouped by label (used by the frontend gallery and lightbox).
- Deleting a photo also removes the file from Cloudinary using the stored `publicId`.

## PDF Generation Pipeline

1. The `/submit` route enqueues a `generate-pod-slip` job into a single BullMQ queue (fixed `jobId: pod-slip-${id}`, `removeOnFail: true` — prevents duplicate jobs on repeat clicks while allowing retries after failure), passing only the data needed (job id, actor info). `podSlipStatus` is set to `pending`.
2. The worker picks up the job and fetches the full job data, boxes, items, and photos from MongoDB.
3. A SHA-256 `sourceHash` is computed over all template-feeding fields and compared with the stored one. If nothing changed, the worker sets `podSlipStatus` to `unchanged` and stops.
4. Otherwise, data is injected into a static HTML template (invoice details merged in as the first page, box-wise item details, standardised `sender*` fields).
5. Puppeteer renders the HTML to a PDF buffer (POD slip first, then one page per uploaded photo).
6. The buffer is uploaded to Cloudinary (raw resource type, `.pdf` extension baked into the public ID). The file name includes the partner name, a timestamp, a count, and a version; count and version reset daily (based on `BUSINESS_TZ`).
7. The resulting URL, `publicId`, and hashes are saved to `PodSlip` (upserted per job), and the previous Cloudinary file is deleted so orphaned PDFs don't accumulate.
8. `podSlipStatus` becomes `ready` (or `failed` if rendering fails), and an audit log entry (`podSlipGenerated`) is recorded.

On Render, the worker launches Chromium via `@sparticuz/chromium` + `puppeteer-core` (detected via `RENDER=true`); locally it dynamically imports standard `puppeteer` to avoid module resolution issues.

Generation typically completes within 40 seconds, though first-request cold starts on Render's free tier can add noticeable delay. The frontend polls the status with a bounded number of attempts.

## Item Name Suggestions

`GET /api/jobs/pickup/items/suggestions` returns all distinct `itemName` values ever recorded (`JobItem.distinct("itemName")`). Given the expected ceiling of a few hundred unique item names, the frontend fetches this list once per form load and filters it client-side as the user types, rather than querying on every keystroke.

## Job List, Search & Export

`GET /api/jobs` (admin job list) supports `page` and `limit` query params alongside existing filters (`status`, `assignedToId`, `clientName`, `fromDate`, `toDate`). `clientName` search is used with a debounced input on the frontend. The response includes `totalJobs` (the page's results — name kept for frontend compatibility), `totalCount`, `totalPages`, and `currentPage`. The count query runs in parallel with the paginated find via `Promise.all`.

Jobs can also be exported as CSV by admins.

## Environment Variables

```dotenv
PORT=
MONGO_URI=
JWT_SECRET=
REDIS_URL=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
RENDER=
BUSINESS_TZ=
```

## Not Yet Built

- BullMQ scheduled auto-lock job (`jobAutoLocked`) — manual lock/unlock exists, automatic time-based locking does not yet
- Auto-archive delay for cancelled jobs
- Multi-tenancy (shared DB with `companyId` vs. DB-per-tenant) — deferred until the single-tenant feature set is complete
- Automated database backups (Atlas free tier has none)
