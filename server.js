const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Odaların durumunu hafızada saklayan ana obje
const rooms = {};

io.on("connection", (socket) => {
    
    // Odaya Katılma (Oyuncu veya Admin)
    socket.on("joinRoom", ({ room, name, role }, callback) => {
        if (role === "admin") {
            if (!rooms[room]) {
                rooms[room] = {
                    adminId: socket.id,
                    youtubeId: "",
                    chatId: "", // Yeni eklenen Chat ID alanı
                    players: {},
                    currentQuestion: null,
                    timer: null
                };
            } else {
                rooms[room].adminId = socket.id;
            }
            socket.join(room);
            callback({ success: true });
            // Admin bağlandığında mevcut liderlik tablosunu yolla
            io.to(socket.id).emit("updateLeaderboard", rooms[room].players);
            return;
        }

        // Oyuncu katılımı kontrolü
        if (!rooms[room]) {
            return callback({ success: false, message: "Böyle aktif bir oda bulunamadı kanka!" });
        }
        if (rooms[room].players[name] !== undefined) {
            return callback({ success: false, message: "Bu isim odada zaten kullanımda." });
        }

        rooms[room].players[name] = 0; // Başlangıç skoru sıfır
        socket.join(room);
        socket.roomName = room;
        socket.playerName = name;

        // Oyuncu girdiğinde hem yayın id hem chat id bilgisini gönderiyoruz
        callback({ success: true, youtubeId: rooms[room].youtubeId, chatId: rooms[room].chatId });
        
        // Admin tablosunu güncelle
        io.to(rooms[room].adminId).emit("updateLeaderboard", rooms[room].players);
    });

    // YouTube Yayını ve Chat Ayarlama
    socket.on("setStream", ({ room, youtubeId, chatId }) => {
        if (rooms[room]) {
            rooms[room].youtubeId = youtubeId;
            rooms[room].chatId = chatId;
            // Odadaki tüm oyunculara hem yayın hem chat id'sini fırlatıyoruz
            socket.to(room).emit("updateStream", { youtubeId, chatId });
        }
    });

    // Soru Başlatma Mekanizması
    socket.on("startQuestion", (questionData) => {
        const { room, type, question, correctAnswer, duration } = questionData;
        if (!rooms[room]) return;

        // Eski bir zamanlayıcı varsa temizle
        if (rooms[room].timer) clearInterval(rooms[room].timer);

        rooms[room].currentQuestion = {
            type,
            correctAnswer,
            duration,
            startTime: Date.now(),
            answersReceived: new Set() // Bu soruda cevap verenler
        };

        // Oyunculara soruyu ilet (Doğru cevap bilgisini saklayarak)
        const clientQuestion = { type, question };
        if (type === "choice") {
            clientQuestion.a = questionData.a;
            clientQuestion.b = questionData.b;
            clientQuestion.c = questionData.c;
            clientQuestion.d = questionData.d;
        }
        io.to(room).emit("newQuestion", clientQuestion);

        // Geri Sayım Zamanlayıcısı
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

    // Cevap Gönderme ve Dinamik Puanlama
    socket.on("submitAnswer", ({ room, name, answer }) => {
        const roomData = rooms[room];
        if (!roomData || !roomData.currentQuestion) return;

        const q = roomData.currentQuestion;
        if (q.answersReceived.has(name)) return; // Zaten cevap verdiyse engelle

        q.answersReceived.add(name);
        
        let isCorrect = false;

        // BÜYÜK/KÜÇÜK HARF DUYARSIZLIĞI KONTROLÜ
        if (q.type === "text") {
            if (answer.trim().toLowerCase() === q.correctAnswer.trim().toLowerCase()) {
                isCorrect = true;
            }
        } else {
            if (answer.toUpperCase() === q.correctAnswer.toUpperCase()) {
                isCorrect = true;
            }
        }

        if (isCorrect) {
            // Hızlı yazana çok puan mantığı (En fazla 100, en az 40 puan)
            const elapsed = (Date.now() - q.startTime) / 1000;
            const speedRatio = Math.max(0, 1 - (elapsed / q.duration));
            const bonus = Math.round(speedRatio * 60); 
            const finalScore = 40 + bonus;

            roomData.players[name] += finalScore;
        }
    });

    // Bağlantı Koptuğunda Temizlik
    socket.on("disconnect", () => {
        const room = socket.roomName;
        const name = socket.playerName;
        if (room && rooms[room] && rooms[room].players[name] !== undefined) {
            delete rooms[room].players[name];
            io.to(rooms[room].adminId).emit("updateLeaderboard", rooms[room].players);
        }
    });
});

// Soruyu Bitirme ve Sonuçları Dağıtma Fonksiyonu
function endQuestion(room) {
    const roomData = rooms[room];
    if (!roomData || !roomData.currentQuestion) return;

    const correctAnswer = roomData.currentQuestion.correctAnswer;
    roomData.currentQuestion = null;

    io.to(room).emit("questionEnded", {
        correctAnswer: correctAnswer,
        scores: roomData.players
    });

    // Admin panelindeki liderlik tablosunu son duruma göre güncelle
    io.to(roomData.adminId).emit("updateLeaderboard", roomData.players);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server ${PORT} üzerinde canavar gibi çalışıyor kanka...`);
});
