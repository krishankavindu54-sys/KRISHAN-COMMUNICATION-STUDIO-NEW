const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const { dbService } = require('./database');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'krishan-pos-jwt-super-secret-key-2026';
const SESSION_DURATION = 12 * 60 * 60 * 1000; // 12 hours

// Socket.io Realtime Setup
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
    },
    pingTimeout: 20000,
    pingInterval: 10000
});

let connectedClients = 0;

io.on('connection', (socket) => {
    connectedClients++;
    console.log(`⚡ [Realtime] Device connected: ${socket.id} (Online devices: ${connectedClients})`);

    // Send connection acknowledgement & initial stats
    socket.emit('sync:welcome', {
        serverTime: new Date().toISOString(),
        deviceCount: connectedClients,
        socketId: socket.id
    });

    // Broadcast updated device count to all connected clients
    io.emit('sync:device_count', { count: connectedClients });

    // Handle full snapshot request
    socket.on('sync:request_full', (callback) => {
        try {
            const data = dbService.exportAllData();
            if (typeof callback === 'function') {
                callback({ success: true, data });
            } else {
                socket.emit('sync:full_snapshot', data);
            }
        } catch (err) {
            console.error('Error serving full snapshot:', err);
            if (typeof callback === 'function') callback({ success: false, error: err.message });
        }
    });

    // Handle latency ping
    socket.on('sync:ping', (data, callback) => {
        if (typeof callback === 'function') {
            callback({ serverTime: Date.now() });
        }
    });

    socket.on('disconnect', () => {
        connectedClients = Math.max(0, connectedClients - 1);
        console.log(`🔌 [Realtime] Device disconnected: ${socket.id} (Online devices: ${connectedClients})`);
        io.emit('sync:device_count', { count: connectedClients });
    });
});

// Realtime Broadcast Helper
function broadcastSync(type, data, originSocketId = null) {
    const payload = {
        type,
        data,
        timestamp: new Date().toISOString(),
        origin: originSocketId
    };

    if (originSocketId) {
        io.except(originSocketId).emit('sync:event', payload);
    } else {
        io.emit('sync:event', payload);
    }
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(__dirname));

// JWT Helpers
function createToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: '12h' }
    );
}

function verifyToken(req) {
    const token = req.cookies?.pos_token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return null;
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

// Middleware
function requireAuth(req, res, next) {
    const user = verifyToken(req);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    const user = verifyToken(req);
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
    }
    req.user = user;
    next();
}

// Helper to get socket origin header
function getSocketId(req) {
    return req.headers['x-socket-id'] || null;
}

// ──────────────────────────────────────────────
// AUTHENTICATION ROUTES
// ──────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password are required.' });
        }

        const user = dbService.getUserByUsername(username.trim());
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }

        const payload = { id: user.id, username: user.username, role: user.role, name: user.name };
        const token = createToken(payload);

        const isHttps = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https' || isServerless);
        res.cookie('pos_token', token, {
            httpOnly: true,
            sameSite: isHttps ? 'none' : 'lax',
            secure: isHttps,
            maxAge: SESSION_DURATION
        });

        return res.json({
            success: true,
            message: 'Login successful',
            user: payload,
            token
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('pos_token');
    res.json({ success: true, message: 'Logged out successfully.' });
});

app.get('/api/auth/me', (req, res) => {
    const user = verifyToken(req);
    if (!user) {
        return res.status(401).json({ authenticated: false, message: 'No active session' });
    }
    return res.json({ authenticated: true, user });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });
        }

        const user = dbService.getUserByUsername(req.user.username);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
        }

        dbService.updateUser(user.id, { password: newPassword });
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error updating password.' });
    }
});

// ──────────────────────────────────────────────
// USER MANAGEMENT (Admin Only)
// ──────────────────────────────────────────────

app.get('/api/users', requireAdmin, (req, res) => {
    try {
        const users = dbService.getUsers();
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/users', requireAdmin, (req, res) => {
    try {
        const { username, password, role, name } = req.body;
        if (!username || !password || !name) {
            return res.status(400).json({ success: false, message: 'Username, password, and name are required.' });
        }

        const existing = dbService.getUserByUsername(username);
        if (existing) {
            return res.status(400).json({ success: false, message: 'Username already exists.' });
        }

        const newUser = dbService.createUser({ username, password, role: role || 'cashier', name });
        res.json({ success: true, user: newUser });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
    try {
        const { name, role, password } = req.body;
        const updated = dbService.updateUser(req.params.id, { name, role, password });
        if (!updated) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, user: updated });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
    try {
        const userId = Number(req.params.id);
        if (req.user.id === userId) {
            return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
        }
        dbService.deleteUser(userId);
        res.json({ success: true, message: 'User deleted.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ──────────────────────────────────────────────
// POS DATA CRUD ENDPOINTS (WITH REALTIME SYNC)
// ──────────────────────────────────────────────

// Items / Inventory
app.get('/api/items', requireAuth, (req, res) => {
    res.json(dbService.getItems());
});

app.post('/api/items', requireAuth, (req, res) => {
    const item = dbService.createItem(req.body);
    broadcastSync('ITEM_CREATED', item, getSocketId(req));
    res.json(item);
});

app.put('/api/items/:id', requireAuth, (req, res) => {
    const item = dbService.updateItem(req.params.id, req.body);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    broadcastSync('ITEM_UPDATED', item, getSocketId(req));
    res.json(item);
});

app.post('/api/items/:id/adjust-stock', requireAuth, (req, res) => {
    const delta = Number(req.body.delta) || 0;
    const item = dbService.adjustItemStock(req.params.id, delta);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    broadcastSync('STOCK_CHANGED', { id: Number(req.params.id), stock: item.stock, delta, item }, getSocketId(req));
    res.json(item);
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deleteItem(id);
    broadcastSync('ITEM_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Sales
app.get('/api/sales', requireAuth, (req, res) => {
    res.json(dbService.getSales());
});

app.post('/api/sales', requireAuth, (req, res) => {
    const saleData = { ...req.body, userId: req.user.id };
    const sale = dbService.createSale(saleData);
    
    // Broadcast sale created along with affected fresh items stock
    broadcastSync('SALE_CREATED', {
        sale,
        items: dbService.getItems(),
        cashier: req.user.name || req.user.username
    }, getSocketId(req));
    
    res.json(sale);
});

app.delete('/api/sales/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deleteSale(id);
    broadcastSync('SALE_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Repairs
app.get('/api/repairs', requireAuth, (req, res) => {
    res.json(dbService.getRepairs());
});

app.post('/api/repairs', requireAuth, (req, res) => {
    const repair = dbService.createRepair(req.body);
    broadcastSync('REPAIR_CREATED', repair, getSocketId(req));
    res.json(repair);
});

app.put('/api/repairs/:id', requireAuth, (req, res) => {
    const repair = dbService.updateRepair(req.params.id, req.body);
    if (!repair) return res.status(404).json({ message: 'Repair not found' });
    broadcastSync('REPAIR_UPDATED', repair, getSocketId(req));
    res.json(repair);
});

app.delete('/api/repairs/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deleteRepair(id);
    broadcastSync('REPAIR_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Expenses
app.get('/api/expenses', requireAuth, (req, res) => {
    res.json(dbService.getExpenses());
});

app.post('/api/expenses', requireAuth, (req, res) => {
    const expense = dbService.createExpense(req.body);
    broadcastSync('EXPENSE_CREATED', expense, getSocketId(req));
    res.json(expense);
});

app.delete('/api/expenses/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deleteExpense(id);
    broadcastSync('EXPENSE_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Creditors / Credit Book
app.get('/api/creditors', requireAuth, (req, res) => {
    res.json(dbService.getCreditors());
});

app.post('/api/creditors', requireAuth, (req, res) => {
    const creditor = dbService.createCreditor(req.body);
    broadcastSync('CREDITOR_CREATED', creditor, getSocketId(req));
    res.json(creditor);
});

app.put('/api/creditors/:id', requireAuth, (req, res) => {
    const creditor = dbService.updateCreditor(req.params.id, req.body);
    if (!creditor) return res.status(404).json({ message: 'Creditor not found' });
    broadcastSync('CREDITOR_UPDATED', creditor, getSocketId(req));
    res.json(creditor);
});

app.delete('/api/creditors/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deleteCreditor(id);
    broadcastSync('CREDITOR_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Bank Transactions
app.get('/api/bank-transactions', requireAuth, (req, res) => {
    res.json(dbService.getBankTransactions());
});

app.post('/api/bank-transactions', requireAuth, (req, res) => {
    const tx = dbService.createBankTransaction(req.body);
    broadcastSync('BANK_TX_CREATED', tx, getSocketId(req));
    res.json(tx);
});

app.delete('/api/bank-transactions/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deleteBankTransaction(id);
    broadcastSync('BANK_TX_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Suppliers
app.get('/api/suppliers', requireAuth, (req, res) => {
    res.json(dbService.getSuppliers());
});

app.post('/api/suppliers', requireAuth, (req, res) => {
    const supplier = dbService.createSupplier(req.body);
    broadcastSync('SUPPLIER_CREATED', supplier, getSocketId(req));
    res.json(supplier);
});

app.delete('/api/suppliers/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deleteSupplier(id);
    broadcastSync('SUPPLIER_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Purchase Bills
app.get('/api/purchase-bills', requireAuth, (req, res) => {
    res.json(dbService.getPurchaseBills());
});

app.post('/api/purchase-bills', requireAuth, (req, res) => {
    const bill = dbService.createPurchaseBill(req.body);
    broadcastSync('BILL_CREATED', bill, getSocketId(req));
    res.json(bill);
});

app.put('/api/purchase-bills/:id', requireAuth, (req, res) => {
    const bill = dbService.updatePurchaseBill(req.params.id, req.body);
    if (!bill) return res.status(404).json({ message: 'Purchase bill not found' });
    broadcastSync('BILL_UPDATED', bill, getSocketId(req));
    res.json(bill);
});

app.delete('/api/purchase-bills/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    dbService.deletePurchaseBill(id);
    broadcastSync('BILL_DELETED', { id }, getSocketId(req));
    res.json({ success: true });
});

// Settings
app.get('/api/settings', (req, res) => {
    res.json(dbService.getSettings());
});

app.post('/api/settings', requireAuth, (req, res) => {
    const { key, value } = req.body;
    dbService.setSetting(key, value);
    broadcastSync('SETTINGS_UPDATED', { key, value }, getSocketId(req));
    res.json({ success: true });
});

// Full Sync & Diagnostics
app.get('/api/sync/full', requireAuth, (req, res) => {
    const data = dbService.exportAllData();
    res.json({ success: true, data, timestamp: new Date().toISOString() });
});

// Batch Sync (Offline Queue Processor)
app.post('/api/sync/batch', requireAuth, (req, res) => {
    try {
        const { operations } = req.body || {};
        if (!Array.isArray(operations) || operations.length === 0) {
            return res.json({ success: true, processed: 0 });
        }

        const results = [];
        for (const op of operations) {
            try {
                switch (op.type) {
                    case 'create_item':
                        results.push({ opId: op.id, result: dbService.createItem(op.payload) });
                        break;
                    case 'update_item':
                        results.push({ opId: op.id, result: dbService.updateItem(op.targetId, op.payload) });
                        break;
                    case 'create_sale':
                        results.push({ opId: op.id, result: dbService.createSale({ ...op.payload, userId: req.user.id }) });
                        break;
                    case 'create_repair':
                        results.push({ opId: op.id, result: dbService.createRepair(op.payload) });
                        break;
                    case 'update_repair':
                        results.push({ opId: op.id, result: dbService.updateRepair(op.targetId, op.payload) });
                        break;
                    case 'create_expense':
                        results.push({ opId: op.id, result: dbService.createExpense(op.payload) });
                        break;
                    case 'create_creditor':
                        results.push({ opId: op.id, result: dbService.createCreditor(op.payload) });
                        break;
                    case 'update_creditor':
                        results.push({ opId: op.id, result: dbService.updateCreditor(op.targetId, op.payload) });
                        break;
                    case 'create_bank_tx':
                        results.push({ opId: op.id, result: dbService.createBankTransaction(op.payload) });
                        break;
                    case 'create_bill':
                        results.push({ opId: op.id, result: dbService.createPurchaseBill(op.payload) });
                        break;
                    default:
                        break;
                }
            } catch (err) {
                console.error(`Error processing batch operation ${op.id}:`, err);
                results.push({ opId: op.id, error: err.message });
            }
        }

        // Broadcast full update after batch
        broadcastSync('BATCH_SYNC_COMPLETED', { timestamp: new Date().toISOString() }, getSocketId(req));

        res.json({ success: true, processed: results.length, results });
    } catch (e) {
        console.error('Batch sync error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Export Backup
app.get('/api/backup/export', requireAuth, (req, res) => {
    const data = dbService.exportAllData();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=pos_backup_${Date.now()}.json`);
    res.send(JSON.stringify(data, null, 2));
});

// Front-end Page routing
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const os = require('os');

function getLocalIPAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const ifaceList = interfaces[devName];
        for (let i = 0; i < ifaceList.length; i++) {
            const alias = ifaceList[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

const localIP = getLocalIPAddress();

app.server = server;
app.io = io;
module.exports = app;

if (!process.env.VERCEL) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`=========================================`);
        console.log(`🚀 Krishan POS Realtime Server Running!`);
        console.log(`💻 This Computer:  http://localhost:${PORT} or http://krishanpos.local`);
        console.log(`📱 Other Devices:  http://${localIP}:${PORT}`);
        console.log(`⚡ Realtime Sync:  WebSocket Active on Port ${PORT}`);
        console.log(`🔑 Default Admin:  admin / admin123`);
        console.log(`=========================================`);
    });

    // Attempt direct port 80 helper (if running as admin)
    if (Number(PORT) !== 80) {
        const http80 = require('http');
        const server80 = http80.createServer(app);
        server80.listen(80, '0.0.0.0', () => {
            console.log(`✨ Direct Port 80 active (Visit http://${localIP})`);
        }).on('error', () => {
            // Port 80 busy/forbidden, port 3000 remains active
        });
    }
}
