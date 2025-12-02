const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');

// 配置
const PORT = 3000;
const LOG_DIR = path.join(__dirname, 'logs');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 确保目录存在
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const app = express();
const server = http.createServer(app);

// 允许跨域（方便前端调试，生产环境可限制域名）
app.use(cors());
app.use(express.json());
// 静态托管上传的文件
app.use('/uploads', express.static(UPLOAD_DIR));

// 静态托管前端文件（将项目根目录作为静态目录，访问 / 时返回 index.html）
app.use(express.static(path.join(__dirname)));

// 根路径直接返回前端页面 index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 文件上传配置（支持任意文件）
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const io = new Server(server, {
    cors: { origin: "*" }
});

// UUID helper: prefer crypto.randomUUID when available
let randomUUID = null;
try {
    const crypto = require('crypto');
    if (crypto && crypto.randomUUID) randomUUID = () => crypto.randomUUID();
} catch (e) { }
if (!randomUUID) {
    // fallback UUID v4
    randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- 工具函数：读写日志 ---
// 采用简单的 JSON 数组存储。生产环境如果日志巨大，建议改用追加写入文本行或数据库。
const getLogFilePath = (channelId) => path.join(LOG_DIR, `${channelId}.json`);

const readLogs = (channelId) => {
    const filePath = getLogFilePath(channelId);
    if (!fs.existsSync(filePath)) return [];
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        return [];
    }
};

const writeLog = (channelId, messageObj) => {
    const logs = readLogs(channelId);
    logs.push(messageObj);
    fs.writeFileSync(getLogFilePath(channelId), JSON.stringify(logs, null, 2));
};

// --- API 接口 ---

// 1. 获取历史记录
app.get('/api/history/:channelId', (req, res) => {
    const logs = readLogs(req.params.channelId);
    res.json(logs);
});

// 1.5 获取原始日志文本（返回 text/plain）
app.get('/api/get-logs/:channelId', (req, res) => {
    const channelId = req.params.channelId;
    const filePath = getLogFilePath(channelId);
    if (!fs.existsSync(filePath)) {
        return res.status(404).type('text/plain; charset=utf-8').send('');
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        res.type('text/plain; charset=utf-8').send(raw);
    } catch (e) {
        console.error('Error reading log file:', e);
        res.status(500).type('text/plain; charset=utf-8').send('');
    }
});

// Debug: 返回房间内的 socket 列表与计数（便于排查是否有客户端 join）
app.get('/api/room/:channelId', (req, res) => {
    try {
        const cid = req.params.channelId;
        const room = io.sockets.adapter.rooms.get(cid);
        const sockets = room ? Array.from(room) : [];
        return res.json({ channelId: cid, count: sockets.length, sockets });
    } catch (e) {
        console.error('room info error', e);
        return res.status(500).json({ error: 'internal' });
    }
});

// 2. 上传文件接口（接受任意文件，字段名：file）
// 可选表单字段：channelId, username — 若提供则会把文件消息广播到该频道并写入历史
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // 返回文件的可访问 URL 及元信息
    const fileUrl = `/uploads/${req.file.filename}`;
    const fileMeta = {
        url: fileUrl,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size
    };

    // 如果上传表单里带了 channelId，则把文件消息写入该频道的历史并广播
    const { channelId, username, userid } = req.body || {};
    if (channelId) {
        // userid 优先使用传入的 userid，否则用 username 作为 userid
        const uid = userid || username || 'unknown';
        const senderName = username || uid;
        const messageObj = {
            messageId: randomUUID(),
            time: new Date().toISOString(),
            sender: senderName,
            userid: uid,
            content: fileMeta,
            type: 'file',
            reactions: { like: [], disagree: [], done: [] },
            clientId: "from-api-upload-" + randomUUID() // 标记为 API 上传来源,

        };
        // 支持来自表单的 clientId，用于前端乐观更新匹配（可选）
        if (req.body && req.body.clientId) messageObj.clientId = req.body.clientId;
        // 支持来自表单的 quotedMessageId（引用的消息 id）
        if (req.body && req.body.quotedMessageId) messageObj.quotedMessageId = req.body.quotedMessageId;
        // 存入本地文件并广播
        try {
            writeLog(channelId, messageObj);
            io.to(channelId).emit('newMessage', messageObj);
        } catch (e) {
            console.error('Error while logging/broadcasting uploaded file:', e);
        }
    }

    res.json(fileMeta);
});

// 2.5 直接发送文本消息的 HTTP API（便于服务端或外部系统发消息）
// 请求体: { channelId, userid, username, content, clientId?, quotedMessageId? }
app.post('/api/send-msg', (req, res) => {
    try {
        const { channelId, userid, username, content } = req.body || {};
        if (!channelId || !content) return res.status(400).json({ error: 'channelId and content required' });

        const uid = userid || username || 'unknown';
        const senderName = username || uid;

        const messageObj = {
            messageId: randomUUID(),
            time: new Date().toISOString(),
            sender: senderName,
            userid: uid,
            content: content,
            type: 'text',
            reactions: { like: [], disagree: [], done: [] },
            clientId: "from-api-upload-" + randomUUID() // 标记为 API 上传来源,
        };

        if (req.body && req.body.clientId) messageObj.clientId = req.body.clientId;
        if (req.body && req.body.quotedMessageId) messageObj.quotedMessageId = req.body.quotedMessageId;

        writeLog(channelId, messageObj);
        io.to(channelId).emit('newMessage', messageObj);
        // 记录日志，便于调试为何有时客户端没收到（例如未正确 join）
        console.log(`[send-msg] broadcast to channel ${channelId}:`, messageObj.messageId);


        return res.json(messageObj);
    } catch (e) {
        console.error('send-msg error', e);
        return res.status(500).json({ error: 'internal error' });
    }
});

// --- Socket.io 实时通信 ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 加入频道
    socket.on('join', (channelId) => {
        socket.join(channelId);
        console.log(`[socket] ${socket.id} joined ${channelId}`);
        // 发送该频道的历史记录给新用户
        const history = readLogs(channelId);
        socket.emit('history', history);
    });

    // 接收消息
    socket.on('message', (data) => {
        // data 结构: { channelId, username, userid, content, type: 'text'|'image'|'file', time }
        const { channelId, username, userid, content, type } = data;

        // userid 优先使用传入的 userid，否则用 username 作为 userid
        const uid = userid || username || 'unknown';
        const senderName = username || uid;

        const messageObj = {
            messageId: randomUUID(),
            time: new Date().toISOString(),
            sender: senderName,
            userid: uid,
            content: content,
            type: type || 'text',
            reactions: { like: [], disagree: [], done: [] }
        };
        // 如果客户端提供了 clientId（用于前端乐观更新的匹配），一并保存并透传
        if (data.clientId) messageObj.clientId = data.clientId;
        // 如果客户端提供了 quotedMessageId（引用的消息 id），一并保存并透传
        if (data.quotedMessageId) messageObj.quotedMessageId = data.quotedMessageId;

        // 1. 存入本地文件
        writeLog(channelId, messageObj);

        // 2. 广播给频道内所有人 (包括发送者，确认消息已上链)
        io.to(channelId).emit('newMessage', messageObj);
    });

    // 处理 reaction 交互（toggle）
    // data: { channelId, messageId, userid, action }
    socket.on('reaction', (data) => {
        try {
            const { channelId, messageId, userid, action } = data || {};
            if (!channelId || !messageId || !userid || !action) return;
            const logs = readLogs(channelId);
            const idx = logs.findIndex(m => m.messageId === messageId || m.clientId === messageId);
            if (idx === -1) return;
            const msg = logs[idx];
            if (!msg.reactions) msg.reactions = { like: [], disagree: [], done: [] };
            const arr = msg.reactions[action];
            if (!Array.isArray(arr)) return;
            const exists = arr.indexOf(userid) !== -1;
            if (exists) {
                // 取消
                msg.reactions[action] = arr.filter(u => u !== userid);
            } else {
                // 加入（并确保去重）
                msg.reactions[action] = Array.from(new Set(arr.concat([userid])));
            }
            // 保存并广播更新
            logs[idx] = msg;
            fs.writeFileSync(getLogFilePath(channelId), JSON.stringify(logs, null, 2));
            io.to(channelId).emit('updateMessage', msg);
        } catch (e) {
            console.error('reaction error', e);
        }
    });

    // 处理消息撤回（recall）请求
    // data: { channelId, messageId, userid }
    socket.on('recall', (data) => {
        try {
            const { channelId, messageId, userid } = data || {};
            if (!channelId || !messageId || !userid) return;
            const logs = readLogs(channelId);
            const idx = logs.findIndex(m => m.messageId === messageId || m.clientId === messageId);
            if (idx === -1) return;
            const msg = logs[idx];
            // 只有发送者本人可以撤回
            if (String(msg.userid) !== String(userid)) return;
            // 检查时间限制：2 分钟内可撤回
            const msgTime = new Date(msg.time).getTime();
            if (isNaN(msgTime)) return;
            const now = Date.now();
            if (now - msgTime > 2 * 60 * 1000) return;

            // 标记为已撤回并保留原始信息用于审计
            msg.retracted = true;
            msg.retractedBy = userid;
            msg.retractedAt = new Date().toISOString();
            // 可选择清理 content，但保留字段更利于审计；这里我们保留 content 但将 type 标注为 'retracted'
            msg.type = 'retracted';

            // 持久化并广播更新
            logs[idx] = msg;
            fs.writeFileSync(getLogFilePath(channelId), JSON.stringify(logs, null, 2));
            io.to(channelId).emit('updateMessage', msg);
        } catch (e) {
            console.error('recall error', e);
        }
    });
});

server.listen(PORT, () => {
    console.log(`LogChat Server running on http://localhost:${PORT}`);
});