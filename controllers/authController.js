import { sql } from "../config/db.js"
import jwt from "jsonwebtoken"

import bcrypt from "bcrypt"


// Generates JWT access token and attaches it to response as HTTP-Only Cookie
export const sendTokenResponse = (
  res,
  userId,
  statusCode = 200,
  extraData = {}
) => {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "7d" })

  const isProduction = process.env.NODE_ENV === 'production'

  res.cookie("token", token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in miliseconds
  })

  res.status(statusCode).json({ token, ...extraData })
}

// Register new user
// POST /api/auth/register
export const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' })
    }

    const normalizedEmail = email.toLowerCase().trim()

    const [existing] = await sql`SELECT id FROM users WHERE email= ${normalizedEmail}`

    if (existing) {
      return res.status(400).json({ error: 'User with this email already exists' })
    }

    const salt = await bcrypt.genSalt(10)
    const hashedPassword = await bcrypt.hash(password, salt);

    const storageLimit = Number(process.env.MAX_STORAGE_PER_USER) || 1073741824 //1GB

    const [user] = await sql`INSERT INTO users (name, email, password, storage_limit) VALUES (${name.trim()}, ${normalizedEmail}, ${hashedPassword}, ${storageLimit}) RETURNING id, name, email, storage_limit, created_at, updated_at`

    return sendTokenResponse(res, user.id, 201, { user });
  } catch (error) {
    console.error("[registerUser] Error:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
}

//Login user
// POST /api/auth/login
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' })
    }

    const normalizedEmail = email.toLowerCase().trim()

    const [user] = await sql`SELECT id, name, email, password, storage_used, storage_limit, created_at, updated_at FROM users WHERE email= ${normalizedEmail}`
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const isMatch = await bcrypt.compare(password, user.password)
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    delete user.password // Borrado para evitar exponer datos sensibles

    return sendTokenResponse(res, user.id, 200, { user });
  } catch (error) {
    console.error("[registerUser] Error:", error);
    res.status(500).json({ error: "Failed to register user" });
  }
}

//Logout user & clear cookie
// POST /api/auth/logout
export const logoutUser = async (_req, res) => {
  try {
    const isProduction = process.env.NODE_ENV === "production"
    res.clearCookie("token", {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
    })

    return res.status(200).json({ message: "Logged out successfully" })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
}

//Get current user profile
// GET /api/auth/me
export const getMe = async (req, res) => {

}