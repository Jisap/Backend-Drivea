import express from "express";
import "dotenv/config";
import cors from "cors"
import cookieParser from "cookie-parser"

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
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`)
})