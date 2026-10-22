import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { pool } from "./db.js";

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
    pingTimeout: 30000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Non authentifié"));
    try {
      const p = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      socket.userId = p.sub;
      next();
    } catch (e) {
      next(new Error("Jeton invalide"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.userId}`);
    socket.on("join", async (conversationId) => {
      try {
        const r = await pool.query(
          "SELECT buyer_id, seller_id FROM conversations WHERE id = $1", [conversationId]
        );
        if (!r.rows.length) return;
        if (![r.rows[0].buyer_id, r.rows[0].seller_id].includes(socket.userId)) return;
        socket.join(`conv:${conversationId}`);
      } catch (e) {}
    });

    socket.on("leave", (conversationId) => {
      socket.leave(`conv:${conversationId}`);
    });
    socket.on("typing", (conversationId) => {
      socket.to(`conv:${conversationId}`).emit("typing", { userId: socket.userId });
    });
  });

  return io;
}
