const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const { dbService } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'krishan-pos-jwt-super-secret-key-2026';
const SESSION_DURATION = 12 * 60 * 60 * 1000; // 12 hours

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
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

        res.cookie('pos_token', token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
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
// POS DATA CRUD ENDPOINTS
// ──────────────────────────────────────────────

// Items / Inventory
app.get('/api/items', requireAuth, (req, res) => {
    res.json(dbService.getItems());
});

app.post('/api/items', requireAuth, (req, res) => {
    const item = dbService.createItem(req.body);
    res.json(item);
});

app.put('/api/items/:id', requireAuth, (req, res) => {
    const item = dbService.updateItem(req.params.id, req.body);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    res.json(item);
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
    dbService.deleteItem(req.params.id);
    res.json({ success: true });
});

// Sales
app.get('/api/sales', requireAuth, (req, res) => {
    res.json(dbService.getSales());
});

app.post('/api/sales', requireAuth, (req, res) => {
    const saleData = { ...req.body, userId: req.user.id };
    const sale = dbService.createSale(saleData);
    res.json(sale);
});

// Repairs
app.get('/api/repairs', requireAuth, (req, res) => {
    res.json(dbService.getRepairs());
});

app.post('/api/repairs', requireAuth, (req, res) => {
    const repair = dbService.createRepair(req.body);
    res.json(repair);
});

app.put('/api/repairs/:id', requireAuth, (req, res) => {
    const repair = dbService.updateRepair(req.params.id, req.body);
    if (!repair) return res.status(404).json({ message: 'Repair not found' });
    res.json(repair);
});

app.delete('/api/repairs/:id', requireAuth, (req, res) => {
    dbService.deleteRepair(req.params.id);
    res.json({ success: true });
});

// Expenses
app.get('/api/expenses', requireAuth, (req, res) => {
    res.json(dbService.getExpenses());
});

app.post('/api/expenses', requireAuth, (req, res) => {
    const expense = dbService.createExpense(req.body);
    res.json(expense);
});

app.delete('/api/expenses/:id', requireAuth, (req, res) => {
    dbService.deleteExpense(req.params.id);
    res.json({ success: true });
});

// Creditors / Credit Book
app.get('/api/creditors', requireAuth, (req, res) => {
    res.json(dbService.getCreditors());
});

app.post('/api/creditors', requireAuth, (req, res) => {
    const creditor = dbService.createCreditor(req.body);
    res.json(creditor);
});

app.put('/api/creditors/:id', requireAuth, (req, res) => {
    const creditor = dbService.updateCreditor(req.params.id, req.body);
    if (!creditor) return res.status(404).json({ message: 'Creditor not found' });
    res.json(creditor);
});

app.delete('/api/creditors/:id', requireAuth, (req, res) => {
    dbService.deleteCreditor(req.params.id);
    res.json({ success: true });
});

// Bank Transactions
app.get('/api/bank-transactions', requireAuth, (req, res) => {
    res.json(dbService.getBankTransactions());
});

app.post('/api/bank-transactions', requireAuth, (req, res) => {
    const tx = dbService.createBankTransaction(req.body);
    res.json(tx);
});

app.delete('/api/bank-transactions/:id', requireAuth, (req, res) => {
    dbService.deleteBankTransaction(req.params.id);
    res.json({ success: true });
});

// Suppliers
app.get('/api/suppliers', requireAuth, (req, res) => {
    res.json(dbService.getSuppliers());
});

app.post('/api/suppliers', requireAuth, (req, res) => {
    const supplier = dbService.createSupplier(req.body);
    res.json(supplier);
});

app.delete('/api/suppliers/:id', requireAuth, (req, res) => {
    dbService.deleteSupplier(req.params.id);
    res.json({ success: true });
});

// Purchase Bills
app.get('/api/purchase-bills', requireAuth, (req, res) => {
    res.json(dbService.getPurchaseBills());
});

app.post('/api/purchase-bills', requireAuth, (req, res) => {
    const bill = dbService.createPurchaseBill(req.body);
    res.json(bill);
});

// Settings
app.get('/api/settings', (req, res) => {
    res.json(dbService.getSettings());
});

app.post('/api/settings', requireAuth, (req, res) => {
    const { key, value } = req.body;
    dbService.setSetting(key, value);
    res.json({ success: true });
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

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🚀 Krishan POS Server Running!`);
    console.log(`💻 This Computer:  http://localhost:${PORT} or http://krishanpos.local`);
    console.log(`📱 Other Devices:  http://${localIP}:${PORT}`);
    console.log(`🔑 Default Admin:  admin / admin123`);
    console.log(`=========================================`);
});

// Also attempt to listen on standard HTTP Port 80 so user can use http://krishanpos.local without specifying :3000
if (Number(PORT) !== 80) {
    const http = require('http');
    const server80 = http.createServer(app);
    server80.listen(80, '0.0.0.0', () => {
        console.log(`✨ Direct Port 80 active (Other devices can also visit http://${localIP})`);
    }).on('error', () => {
        // Port 80 not available, port 3000 remains active
    });
}
