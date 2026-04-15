// Auth temporarily disabled for testing — re-enable before going live
// To re-enable: restore the session check below and uncomment Login in App.jsx
export function requireAuth(req, res, next) {
  next();
}
