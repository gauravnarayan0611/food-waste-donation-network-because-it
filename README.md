# FoodBridge

FoodBridge connects food donors with verified NGOs and delivery partners. The frontend is built with React and JSX, with Vite for development and production bundles. Express, MongoDB/Mongoose, and Socket.IO provide persisted accounts, donations, delivery assignments, and live notifications.

## Requirements

- Node.js 20.6 or later
- MongoDB (local or hosted)

Install dependencies with `npm install`. The server loads configuration from the project-root `.env` file. Copy `.env.example` to `.env` and set `MONGODB_URI` and a private `FOODBRIDGE_JWT_SECRET` of at least 32 characters. A local `.env` has been created for this checkout using the local MongoDB database `foodbridge` and a randomly generated session secret; the file is ignored by Git.

```powershell
npm install
npm start
```

Keep the `.env` file private and do not commit it. Environment variables already set in the shell take precedence over values in `.env`.

For local development, run `npm run dev`. This starts the backend, waits for its database-backed health check, and then starts Vite. Open `http://127.0.0.1:5174`. Vite proxies API and Socket.IO requests to the backend on port 5173. To run only the React frontend, use `npm run dev:frontend` while the backend is already running. Do not use VS Code Live Server or open `index.html` directly; React JSX needs the Vite development server.

For production, build the React frontend and start the backend:

```powershell
npm run build
npm start
```

The Express server serves the production bundle from `dist`. Rebuild after frontend changes.

The previous demo users and browser `localStorage` records are not migrated into the database. Register accounts in the server-backed app and recreate any sample donations that you still need.

## Accounts

Register Donor, NGO, or Rider accounts in the app. New NGO accounts require admin approval before they can claim donations. Admin accounts cannot be self-registered or created by selecting Admin in the login form. Create an Admin account after setting `MONGODB_URI`; use an email address not already registered under another role:

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "<use a unique password with at least 10 characters>"
npm run create-admin
```

Login with the Admin role to approve new NGOs. Passwords are stored as salted scrypt hashes. Sessions use an HttpOnly cookie signed with `FOODBRIDGE_JWT_SECRET`. The `npm run create-admin` script also loads the root `.env` file; set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the shell before running it.

## Delivery workflow

1. A donor submits a donation for Admin approval.
2. An Admin approves it, making it visible to verified NGOs and notifying riders.
3. A verified NGO claims the donation and sets the delivery destination, creating an available rider task.
4. An available rider accepts the task and confirms pickup.
5. The rider marks it delivered; only the assigned NGO can confirm receipt and complete it.

Riders receive a persistent notification when a donor request is approved. The rider can accept the task after an NGO claims it and provides a destination. Accepted deliveries remain in the rider's active-deliveries list, while completed deliveries appear in delivery history. Donation approval reuses the existing donation status fields; it does not add a database model or schema field.

Donation coordinates and handling instructions are optional. If coordinates are not supplied, the rider dashboard uses the existing city coordinates for an approximate distance when possible. Earnings are not shown because the current business logic has no payment or incentive data.

## API

Authenticated API responses use `{ "success": true, "data": ... }`; errors use `{ "success": false, "error": { "code": ..., "message": ... } }`.

Assignment endpoints:

- `GET /api/v1/assignments/available`
- `GET /api/v1/assignments/my-tasks`
- `POST /api/v1/assignments/:id/accept`
- `PATCH /api/v1/assignments/:id/pickup`
- `PATCH /api/v1/assignments/:id/deliver`
- `PATCH /api/v1/assignments/:id/receipt` (receiving NGO only)

Donation approvals are handled by `PATCH /api/v1/admin/donations/:id/approve` (Admin only). New donor submissions are held from NGO listings until approved.

The shared Socket.IO server emits assignment and notification updates. Delivery assignment uses a conditional MongoDB update so a task cannot be accepted by two riders.

## Map

The Map page uses Leaflet with OpenStreetMap tiles and needs an internet connection but no API key. Signed-in users see available donation and verified NGO markers, can open marker details, pan and zoom, and fit the map to all visible markers. Donations use their saved coordinates when available and otherwise the existing city-center approximation. Exact donation locations are only returned through authenticated role-scoped APIs. OpenStreetMap attribution is shown on the map; production deployments with substantial tile traffic should use a tile provider appropriate for that usage.

## Checks

Create the production frontend bundle with:

```powershell
npm run build
```

Run the backend unit tests with `npm test`.
