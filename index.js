const express = require("express");
const { WebSocketServer } = require("ws");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const fs = require("fs");
const WavEncoder = require("wav-encoder");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");
const path = require("path");

dotenv.config();

const app = express();
app.use(cors());

// Health check
app.get("/", (req, res) => {
  res.send("✅ STT Backend is running...");
});

// 🔑 OpenAI setup
if (!process.env.OPENAI_KEY) {
  console.error("❌ Missing OPENAI_KEY in environment");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

// 🔑 Firebase setup (service account via GOOGLE_APPLICATION_CREDENTIALS)
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

// HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// 🔊 PCM16 → Float32
function pcm16ToFloat32(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  const float32 = new Float32Array(buffer.length / 2);
  for (let i = 0; i < buffer.length / 2; i++) {
    const s = view.getInt16(i * 2, true); // little endian
    float32[i] = s / 32768.0;
  }
  return float32;
}

wss.on("connection", (ws) => {
  console.log("🎤 Client connected");

  let audioBuffer = [];

  ws.on("message", async (msg) => {
    try {
      const { meetingId, userId, audio } = JSON.parse(msg.toString());

      if (!meetingId || !userId || !audio) {
        return ws.send(JSON.stringify({ error: "Invalid payload" }));
      }

      // Decode Base64 PCM chunk
      const audioChunk = Buffer.from(audio, "base64");
      audioBuffer.push(audioChunk);

      // Process after ~20 chunks
      if (audioBuffer.length >= 20) {
        const pcmData = Buffer.concat(audioBuffer);
        audioBuffer = [];

        const float32 = pcm16ToFloat32(pcmData);

        const audioData = {
          sampleRate: 16000,
          channelData: [float32],
        };

        const wavBuffer = await WavEncoder.encode(audioData);
        const tempFile = path.join(__dirname, "temp.wav");
        fs.writeFileSync(tempFile, Buffer.from(wavBuffer));

        // 🎙️ Send to Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: "whisper-1",
        });

        const text = transcription.text.trim();
        console.log("📝 Transcript:", text);

        // Save to Firestore
        await db
          .collection("meetings")
          .doc(meetingId)
          .collection("transcripts")
          .add({
            senderId: userId,
            text,
            timestamp: Date.now(),
          });

        // Send back to Flutter client
        ws.send(JSON.stringify({ text }));
      }
    } catch (err) {
      console.error("❌ Error handling message:", err);
      ws.send(JSON.stringify({ error: "Transcription failed" }));
    }
  });

  ws.on("close", () => console.log("❌ Client disconnected"));
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 HTTP + WS Server running on port ${PORT}`);
});
