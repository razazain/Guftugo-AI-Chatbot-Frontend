# Guftugo AI — React frontend

Responsive React JS frontend for Guftugo, connected to the Node.js/Express API and MongoDB-backed account, conversation, document, and usage endpoints.

## Requirements

- Node.js 20 or newer
- npm
- Guftugo backend running and configured with MongoDB Atlas and at least one working LLM provider

## Run locally

1. Extract the ZIP and open this folder in a terminal.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env.local` and verify the backend URL:

   ```env
   VITE_API_BASE_URL=http://localhost:5000/api/v1
   ```

4. Start Vite:

   ```bash
   npm run dev
   ```

5. Open the URL shown by Vite, normally `http://localhost:5173`.

The backend's `CORS_ORIGINS` must include the frontend's origin. The backend defaults normally include `http://localhost:5173`.

## Production build

```bash
npm run build
npm run preview
```

## Connected API features

The frontend uses the attached Postman collection as the endpoint reference and calls the backend using `VITE_API_BASE_URL`.

- **Health:** `GET /health` (available for API checks)
- **Authentication:** `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me`, `PATCH /auth/me`, `PATCH /auth/me/language`, `POST /auth/logout`
- **Chat:** `POST /chat/stream` using Server-Sent Events; text, language, and selected document IDs are sent to the backend
- **Conversations:** `GET /conversations`, `GET /conversations/:id/messages`, `PATCH /conversations/:id`, `DELETE /conversations/:id`
- **Documents:** `POST /documents` (one file per request), `GET /documents`, `DELETE /documents/:id`
- **Usage:** `GET /usage/summary?days=7`

The frontend supports `.txt`, `.md`, `.csv`, and `.json` uploads up to 5 MB each, matching the backend's document service. The web-search control is intentionally unavailable and shows “Coming soon”. Provider names and fallback configuration are not shown in the user interface.

## Logo

The brand image is at `public/assets/guftugo-logo.png`. Replace that file with your final transparent PNG while keeping the same filename.

## Session handling

Access and refresh tokens are stored in browser local storage. A failed authenticated request can attempt refresh-token rotation using the backend's `/auth/refresh` endpoint. For a production deployment, serve the site over HTTPS and review your preferred client-side token-storage policy.
