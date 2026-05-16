const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { LiveChat } = require("youtube-chat");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};
let liveChatListener = null;
let chatBuffer = [];

// --- Levenshtein Mesafe Algoritması ---
function getEditDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function temizleKelime(str) {
    return str.trim().toLowerCase()
        .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
        .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
}

function cevapDogruMu(gelenCevap, dogruCevap, toleransAcik) {
    const temizGelen = temizleKelime(gelenCevap);
    const temizDogru = temizleKelime(dogruCevap);
    
    // Chatten gelen mesaj direkt aranan kelimeyi içeriyor mu veya birebir mi?
    if (temizGelen === temizDogru || temizGelen.includes(temizDogru)) return true;
    if (!toleransAcik) return false;
    
    const toleransLimiti = temizDogru.length <= 4 ? 1 : 2;
    return getEditDistance(temizGelen, temizDogru) <= toleransLimiti;
}

io.on("connection", (socket) => {
    
    socket.on("joinRoom", ({ room, name, role }, callback) => {
        if (role === "admin") {
            if (!rooms[room]) {
                rooms[room] = {
                    adminId: socket.id,
                    youtubeId: "",
                    chatId: "",
                    players: {},
                    currentQuestion: null,
                    timer: null,
                    toleransAcik: true
                };
            } else {
                rooms[room].adminId = socket.id;
            }
            socket.join(room);
            callback({ success: true });
            io.to(socket.id).emit("updateLeaderboard", rooms[room].players);
            return;
        }

        if (!rooms[room]) {
            return callback({ success: false, message: "Böyle aktif bir oda bulunamadı kanka!" });
        }
        if (rooms[room].players[name] !== undefined) {
            return callback({ success: false, message: "Bu isim odada zaten kullanımda." });
        }

        rooms[room].players[name] = 0; 
        socket.join(room);
        socket.roomName = room;
        socket.playerName = name;

        callback({ success: true, youtubeId: rooms[room].youtubeId, chatId: rooms[room].chatId });
        io.to(rooms[room].adminId).emit("updateLeaderboard", rooms[room].players);
    });

    socket.on("setStream", ({ room, youtubeId, chatId }) => {
        if (rooms[room]) {
            let finalId = chatId || youtubeId;
            
            // Link temizleme algoritmamızı sağlama alıyoruz
            if (finalId.includes("v=")) {
                finalId = finalId.split("v=")[1].split("&")[0];
            } else if (finalId.includes("youtu.be/")) {
                finalId = finalId.split("youtu.be/")[1].split("?")[0];
            } else if (finalId.includes("live/")) {
                finalId = finalId.split("live/")[1].split("?")[0];
            }

            rooms[room].youtubeId = youtubeId;
            rooms[room].chatId = finalId;
            
            socket.to(room).emit("updateStream", { youtubeId, chatId: finalId });

            if (liveChatListener) {
                try { liveChatListener.stop(); } catch(e){}
            }

            chatBuffer = [];
            
            // YouTube engelini aşmak için fetch opsiyonları eklenmiş güçlü dinleyici kurgusu
            liveChatListener = new LiveChat({ 
                liveId: finalId,
                interval: 1000 // Chati her 1 saniyede bir agresif şekilde sorgula
            });
            
            liveChatListener.on("start", (liveId) => {
                console.log(`✅ CHAT DİNLEYİCİ AKTİF EDİLDİ -> ID: ${liveId}`);
            });

            liveChatListener.on("error", (err) => {
                console.error("❌ YOUTUBE CHAT BAĞLANTI HATASI:", err);
            });
            
            liveChatListener.on("chat", (chatItem) => {
                if (!chatItem.message || chatItem.message.length === 0) return;
                
                const yazarAdi = chatItem.author.name;
                const mesajMetni = chatItem.message[0].text;
                
                // Arka planda gelen her mesajı sunucu loglarında görelim kanka
                console.log(`💬 [CHAT]: ${yazarAdi} -> ${mesajMetni}`);

                const mevcutMesaj = { author: yazarAdi, text: mesajMetni, id: chatItem.id };
                chatBuffer.push(mevcutMesaj);
                if (chatBuffer.length > 30) chatBuffer.shift();

                const roomData = rooms[room];
                if (!roomData || !roomData.currentQuestion) return;

                const q = roomData.currentQuestion;

                if (cevapDogruMu(mesajMetni, q.correctAnswer, roomData.toleransAcik)) {
                    console.log(`🎯 DOĞRU CEVAP BULUNDU! Kazanan: ${yazarAdi}`);
                    
                    if (roomData.players[yazarAdi] === undefined) {
                        roomData.players[yazarAdi] = 0;
                    }

                    const elapsed = (Date.now() - q.startTime) / 1000;
                    const speedRatio = Math.max(0, 1 - (elapsed / q.duration));
                    const finalScore = 40 + Math.round(speedRatio * 60);

                    roomData.players[yazarAdi] += finalScore;

                    if (roomData.timer) clearInterval(roomData.timer);
                    
                    const kazananIdx = chatBuffer.findIndex(m => m.id === chatItem.id);
                    const onceki = kazananIdx > 0 ? chatBuffer[kazananIdx - 1] : { author: "Sistem", text: "..." };
                    
                    setTimeout(() => {
                        const sonraki = chatBuffer[kazananIdx + 1] || { author: "Sistem", text: "..." };
                        
                        io.to(room).emit("questionEnded", {
                            correctAnswer: q.correctAnswer,
                            winner: yazarAdi,
                            scores: roomData.players,
                            varKesiti: {
                                onceki: `${onceki.author}: ${onceki.text}`,
                                kazanan: `${yazarAdi}: ${mesajMetni}`,
                                sonraki: `${sonraki.author}: ${sonraki.text}`
                            }
                        });
                        
                        io.to(roomData.adminId).emit("updateLeaderboard", roomData.players);
                        roomData.currentQuestion = null;
                    }, 400);
                }
            });

            liveChatListener.start().catch(err => console.error("Chat baslatma hatasi:", err));
        }
    });

    socket.on("startQuestion", (questionData) => {
        const { room, question, correctAnswer, duration, toleransAcik } = questionData;
        if (!rooms[room]) return;

        if (rooms[room].timer) clearInterval(rooms[room].timer);

        rooms[room].toleransAcik = toleransAcik;
        rooms[room].currentQuestion = {
            correctAnswer,
            duration,
            startTime: Date.now()
        };

        io.to(room).emit("newQuestion", { question });

        let timeLeft = duration;
        io.to(room).emit("tick", timeLeft);

        rooms[room].timer = setInterval(() => {
            timeLeft--;
            io.to(room).emit("tick", timeLeft);

            if (timeLeft <= 0) {
                clearInterval(rooms[room].timer);
                endQuestion(room);
            }
        }, 1000);
    });

    socket.on("disconnect", () => {
        const room = socket.roomName;
        const name = socket.playerName;
        if (room && rooms[room] && rooms[room].players[name] !== undefined) {
            delete rooms[room].players[name];
            io.to(rooms[room].adminId).emit("updateLeaderboard", rooms[room].players);
        }
    });
});

function endQuestion(room) {
    const roomData = rooms[room];
    if (!roomData || !roomData.currentQuestion) return;

    const correctAnswer = roomData.currentQuestion.correctAnswer;
    roomData.currentQuestion = null;

    io.to(room).emit("questionEnded", {
        correctAnswer: correctAnswer,
        winner: null,
        scores: roomData.players,
        varKesiti: null
    });

    io.to(roomData.adminId).emit("updateLeaderboard", roomData.players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
