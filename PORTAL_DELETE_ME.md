# DELETE THIS FILE AFTER READING

## What happened

The customer portal frontend was originally pushed to `src/components/PortalApp.jsx` (in the components folder directly) but `src/App.jsx` imports it from `src/components/customer-portal/PortalApp.jsx` (in a `customer-portal/` subfolder). Vite couldn't resolve the import — Render build failed.

The fix was to move the file to where the import expected it, which we've now done at `src/components/customer-portal/PortalApp.jsx`.

## What you need to do

**Delete `src/components/PortalApp.jsx`** (the original, misplaced one — NOT the one in `customer-portal/`).

In GitHub Desktop on Windows: open the repo folder in File Explorer, navigate to `src/components/`, delete `PortalApp.jsx`. GitHub Desktop will pick it up as a deletion in the Changes pane. Commit it alongside whatever else you're committing. Push.

Then **delete this `PORTAL_DELETE_ME.md` file** too — it has done its job.

## Why this matters

The build will work fine without deleting the orphan (Vite only resolves the imported path), but leaving 1000 lines of unused JSX in the repo is confusing for any future code review and adds noise to grep results. Clean up now.
