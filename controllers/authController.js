import { sql } from "../config/db.js"
import bcrypt from "bcrypt"


// Generates JWT access token and attaches it to response as HTTP-Only Cookie
export const sendTokenResponse = () => {

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
  } catch (error) {

  }
}

//Login user
// POST /api/auth/login
export const loginUser = async (req, res) => {
  const { email, password } = req.body;
}

//Logout user & clear cookie
// POST /api/auth/logout
export const logoutUser = async (req, res) => {

}

//Get current user profile
// GET /api/auth/me
export const getMe = async (req, res) => {

}