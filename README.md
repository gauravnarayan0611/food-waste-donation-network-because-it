# FoodBridge

FoodBridge is organized as three independently deployable applications:

```text
Admin/       Separate React/Vite Admin dashboard
frontend/    Public React/Vite app for donors, NGOs, riders, and the map
backend/     Express, MongoDB/Mongoose, and Socket.IO API
scripts/     Local development launcher
```

The Admin console and public website share the backend API and its HttpOnly session cookie, but build and deploy separately. The existing MongoDB models remain in `backend/models/`.

## Requirements and local development

- Node.js 20.6 or later
- MongoDB (local or hosted)

Copy `backend/.env.example` to `backend/.env` and set `MONGODB_URI` and a private `FOODBRIDGE_JWT_SECRET` of at least 32 characters. Keep `.env` files private and never commit credentials.

Install all workspace dependencies and run the three services:

```powershell
npm install
npm run dev
```

Open the public app at `http://127.0.0.1:5174` and the Admin app at `http://127.0.0.1:5175`. The backend health endpoint is `http://127.0.0.1:5173/api/v1/health`. Vite proxies API and Socket.IO calls to the backend for local development.

Run individual services as needed:

```powershell
npm run dev:frontend
npm run dev:admin
npm run dev:backend
```

The standalone frontend and Admin commands need the backend to already be running. For typical local development, use `npm run dev` to start all three together.

Build both frontends with `npm run build`, or build them independently with `npm run build:frontend` and `npm run build:admin`. Output is written to `frontend/dist` and `Admin/dist`. The backend is an API service and does not serve either frontend bundle.

## Deployment

Deploy `backend`, `frontend`, and `Admin` as separate services from the repository root:

| Service | Build command | Start / publish |
| --- | --- | --- |
| Backend | `npm install` | `npm start` (from the `backend` workspace) |
| Public frontend | `npm install && npm run build:frontend` | Publish `frontend/dist` |
| Admin dashboard | `npm install && npm run build:admin` | Publish `Admin/dist` |

Set these frontend build-time variables on both static frontend builds:

- `VITE_API_BASE_URL`: the absolute backend origin, such as `https://api.example.com`
- `VITE_ADMIN_URL`: Admin site URL (public frontend only)
- `VITE_FRONTEND_URL`: public website URL (Admin app only)

Configure the backend environment:

- `MONGODB_URI`: production MongoDB connection string
- `FOODBRIDGE_JWT_SECRET`: private random value of at least 32 characters
- `PORT`: port supplied by the deployment platform (optional for local use)
- `FRONTEND_ORIGINS`: comma-separated, exact public and Admin origins, including scheme, for example `https://app.example.com,https://admin.example.com`
- `FOODBRIDGE_COOKIE_SAME_SITE`: defaults to `lax`. Prefer hosting the API and both sites on subdomains of one domain. For genuinely cross-site deployments, set `none` and serve the API over HTTPS; browser third-party-cookie restrictions can still affect unrelated hosting domains.

The backend permits the two local Vite origins by default. Production browser origins must be listed in `FRONTEND_ORIGINS` for credentialed API and Socket.IO access. Never use wildcard origins with session cookies.

Static hosting must be configured to serve each app's `index.html` for client-side routes. Rebuild the relevant frontend after changing its Vite environment variables.

## Admin account

Admin registration is disabled in the application. Create an Admin account using a unique, unused email:

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "<a unique password of at least 10 characters>"
npm run create-admin
```

In Bash, use:

```bash
ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD='<a unique password of at least 10 characters>' npm run create-admin
```

The backend workspace reads `backend/.env`; environment variables already present in the shell take precedence. Passwords are stored as salted scrypt hashes.

## Delivery workflow

1. A donor submits a donation for Admin approval.
2. Admin approves it, making it visible to verified NGOs and notifying riders.
3. A verified NGO claims the donation and sets the delivery destination, creating an available rider task.
4. An available rider accepts the task and confirms pickup.
5. The rider marks it delivered; only the assigned NGO can confirm receipt and complete it.

Riders receive persistent and live notifications when a donor request is approved and when an NGO makes a task available. The rider dashboard shows active deliveries and a searchable history of every delivery assigned to that rider. Donation approval reuses existing donation status fields and does not add a database model or schema field.

## API

Authenticated API responses use `{ "success": true, "data": ... }`; errors use `{ "success": false, "error": { "code": ..., "message": ... } }`.

- `GET /api/v1/assignments/available`
- `GET /api/v1/assignments/my-tasks`
- `POST /api/v1/assignments/:id/accept`
- `PATCH /api/v1/assignments/:id/pickup`
- `PATCH /api/v1/assignments/:id/deliver`
- `PATCH /api/v1/assignments/:id/receipt` (receiving NGO only)
- `PATCH /api/v1/admin/donations/:id/approve` (Admin only)

Delivery assignment uses a conditional MongoDB update so a task cannot be accepted by two riders. The shared Socket.IO server uses the same authenticated session as the API.

## Checks

```powershell
npm test
npm run build
```
