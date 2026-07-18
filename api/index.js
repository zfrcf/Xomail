// Entrée serverless Vercel : toutes les requêtes /api/mail/* sont réécrites
// vers cette fonction (vercel.json) ; l'app Express route ensuite normalement.
module.exports = require("../app-core");
