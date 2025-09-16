const express = require("express");
const { WebSocketServer } = require("ws");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const fs = require("fs");
const WavEncoder = require("wav-encoder");
const dotenv = require("dotenv");
const cors = require("cors");
const http = require("http");

dotenv.config();

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("✅ STT Backend is running...");
});


// 🔑 Load ENV
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

// Firebase setup (make sure GOOGLE_APPLICATION_CREDENTIALS is set)
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

// Create one HTTP server for Express + WS
const server = http.createServer(app);

// Attach WebSocket to same server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  let audioBuffer = [];

  ws.on("message", async (msg) => {
    try {
      const { meetingId, userId, audio } = JSON.parse(msg.toString());

      // Decode Base64 PCM chunk
      const audioChunk = Buffer.from(audio, "base64");
      audioBuffer.push(audioChunk);

      // Flush every ~20 chunks (~5 sec depending on sample rate)
      if (audioBuffer.length > 20) {
        const pcmData = Buffer.concat(audioBuffer);
        audioBuffer = [];

        // Convert PCM16 → WAV
        const float32 = new Float32Array(
          pcmData.buffer,
          pcmData.byteOffset,
          pcmData.length / 2
        );
        const audioData = {
          sampleRate: 16000,
          channelData: [float32],
        };
        const wavBuffer = await WavEncoder.encode(audioData);
        fs.writeFileSync("temp.wav", Buffer.from(wavBuffer));

        // Transcribe with Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream("temp.wav"),
          model: "whisper-1",
        });

        const text = transcription.text;
        console.log("Transcript:", text);

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

        // Send back to client
        ws.send(JSON.stringify({ text }));
      }
    } catch (err) {
      console.error("Error handling message:", err);
    }
  });
});

// Start HTTP + WebSocket server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 HTTP Server listening on port ${PORT}`);
});
