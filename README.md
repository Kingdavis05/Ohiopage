# Ohio Auto Parts — Full Store (Render-ready)

**What this is**
- Simple full online store (frontend + Node/Express backend).
- Data stored in `db.json` (example products included).
- Orders are saved and a simple "AI automation" placeholder logs order processing to `automation.log`.
- Ready to upload to Render (use the free Render link).

**What's included**
- `server.js` — Node/Express backend (API + admin pages).
- `package.json` — Node dependencies & start script.
- `db.json` — initial products and empty orders array.
- `public/` — static frontend (HTML/JS/CSS).
- `orderProcessor.js` — basic order processor (simulates ordering from suppliers).
- `.env.sample` — environment variables template.
- `README.md` — this file.

---
## Quick iPhone-friendly deploy steps (Render)

1. On your iPhone open Safari and go to https://render.com and **Sign Up / Log In**.
2. Tap **New** → **Web Service**.
3. Choose **Deploy a Docker image** OR **Deploy from a Git repo**. (We'll use upload)
4. Choose the option to **Upload a ZIP** (if Render UI offers it) and upload the ZIP file you downloaded from this chat.
   - If Render doesn't show an upload option, create a free GitHub repo and upload the unzipped files there; then connect the Git repo on Render.
5. Set the **Build Command**: `npm install`
   Set the **Start Command**: `npm start`
6. Add environment variables on Render (Settings → Environment):
   - `PORT` (Render sets automatically; optional)
   - `ADMIN_PASSWORD` — set a password for the admin panel (example: `changeme`)
   - `SUPPLIER_WEBHOOK` — URL where your supplier accepts orders (optional)
7. Deploy. Render will give you a `*.onrender.com` URL. Open it on your iPhone.
8. Use the site: browse products, add to cart, checkout.
   - Admin panel: `https://<your-render-url>/admin` (enter ADMIN_PASSWORD)
9. To connect real suppliers, edit `orderProcessor.js` to call supplier APIs or webhooks.

---
## Notes & Next steps
- **Payments:** This example uses a fake checkout for simplicity. To accept real payments connect Stripe in `server.js` and set API keys in env vars.
- **Security:** This project is a basic demo. Do not use it in production without securing secrets, validating inputs, and using a proper database.
- **Support:** If you want, I can customize the code to integrate a supplier API or Stripe — tell me what provider you want.

