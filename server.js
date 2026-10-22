import express from "express";
import "dotenv/config";
import cors from "cors"
import cookieParser from "cookie-parser"
import { initDB } from "./config/db.js";

const app = express();

//CORS configuration
const allowedOrigins = process.env.ORIGINS.split(",");
app.use(cors({
    origin: allowedOrigins,
    credentials: true
}))

//Middlewares
app.use(cookieParser());
app.use(express.json({ limit: "100mb" }));

//Root API
app.get("/", (_req, res) => res.send("Server is running"))

//Error handling middleware
app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Something went wrong!" })
})

//Start server
const port = process.env.PORT || 3000;

//Initialize DB connection them start server
initDB().then(() => {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`)
    })
}).catch((err) => {
    console.error("Failed to start server", err);
    process.exit(1);
})
