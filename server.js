/*
 * Boîte Mail en ligne — lancement local.
 *
 *   npm install   puis   node server.js   →   http://localhost:8770
 *
 * (Sur Vercel, c'est api/index.js qui sert d'entrée — voir README.)
 */
const app = require("./app-core");

const PORT = process.env.PORT || 8770;

app.listen(PORT, () => {
  console.log(`Boîte Mail en ligne : http://localhost:${PORT}`);
});
