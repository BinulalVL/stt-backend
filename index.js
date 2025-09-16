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
const wss = new WebSocketServer({ server, path: "/ws" });


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

        function pcm16ToFloat32(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
  const float32 = new Float32Array(buffer.length / 2);
  for (let i = 0; i < buffer.length / 2; i++) {
    const s = view.getInt16(i * 2, true); // little endian
    float32[i] = s / 32768.0;
  }
  return float32;
}


        // Convert PCM16 → WAV
        const float32 = pcm16ToFloat32(pcmData);
        
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
