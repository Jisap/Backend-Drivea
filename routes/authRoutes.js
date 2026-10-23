import express from "express";
import { registerUser, loginUser, logoutUser, getMe } from "../controllers/authController";
import { protect } from "../middleware/auth";

const authRouter = express.Router();

authRouter.post("/register", registerUser);
authRouter.post("/login", loginUser);
authRouter.post("/logout", protect, logoutUser);
authRouter.get("/me", protect, getMe);

export default authRouter;