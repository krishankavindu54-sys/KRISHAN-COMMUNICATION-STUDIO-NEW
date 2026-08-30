const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Serverless / Read-Only File System Detection (Vercel, AWS Lambda, Cloud)
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

let DATA_DIR;
if (isServerless) {
    DATA_DIR = path.join('/tmp', 'data');
} else {
    DATA_DIR = path.join(__dirname, 'data');
}

try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
} catch (err) {
    console.warn('Could not create standard DATA_DIR, falling back to /tmp:', err.message);
    DATA_DIR = '/tmp';
}

const DB_PATH = path.join(DATA_DIR, 'pos.sqlite');

let db;
try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
} catch (err) {
    // Fallback in case of environment limitation
}

// Fallback JSON-backed storage if node:sqlite isn't natively accessible in specific runtime
class JsonDatabase {
    constructor(filePath) {
        this.filePath = filePath.replace('.sqlite', '.json');
        this.data = {
            users: [],
            items: [],
            repairs: [],
            sales: [],
            expenses: [],
            creditors: [],
            bank_transactions: [],
            suppliers: [],
            purchase_bills: [],
            settings: {}
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            } else {
                this.save();
            }
        } catch (e) {
            console.error('Error loading json database:', e);
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            console.error('Error saving json database:', e);
        }
    }
}

const jsonDb = !db ? new JsonDatabase(DB_PATH) : null;

// Initialize Database Tables
function initDatabase() {
    if (db) {
        // SQLite Tables
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'cashier',
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                barcode TEXT,
                category TEXT NOT NULL DEFAULT 'General',
                type TEXT NOT NULL DEFAULT 'product',
                price REAL NOT NULL DEFAULT 0,
                cost REAL NOT NULL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0,
                min_stock INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS repairs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_name TEXT NOT NULL,
                phone_model TEXT NOT NULL,
                issue TEXT,
                estimated_cost REAL DEFAULT 0,
                advance_payment REAL DEFAULT 0,
                status TEXT DEFAULT 'pending',
                contact TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                total REAL NOT NULL,
                discount REAL DEFAULT 0,
                payment_method TEXT DEFAULT 'cash',
                cash_received REAL DEFAULT 0,
                change_amount REAL DEFAULT 0,
                items_json TEXT NOT NULL,
                customer_name TEXT,
                customer_phone TEXT,
                user_id INTEGER,
                is_utility INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                category TEXT NOT NULL,
                amount REAL NOT NULL,
                description TEXT
            );

            CREATE TABLE IF NOT EXISTS creditors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT,
                amount REAL NOT NULL DEFAULT 0,
                type TEXT NOT NULL DEFAULT 'receivable',
                last_updated TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS bank_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                note TEXT
            );

            CREATE TABLE IF NOT EXISTS suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                company TEXT,
                phone TEXT,
                address TEXT
            );

            CREATE TABLE IF NOT EXISTS purchase_bills (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                supplier_id INTEGER,
                supplier_name TEXT,
                date TEXT NOT NULL,
                total REAL NOT NULL DEFAULT 0,
                status TEXT DEFAULT 'pending',
                items_json TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        // Seed default admin user if not exists
        const adminCheck = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
        if (!adminCheck) {
            const passwordHash = bcrypt.hashSync('admin123', 10);
            db.prepare(`
                INSERT INTO users (username, password_hash, role, name, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run('admin', passwordHash, 'admin', 'Administrator', new Date().toISOString());
            console.log('✅ Default Admin created: username=admin, password=admin123');
        }

        // Seed sample items if empty
        const countRow = db.prepare('SELECT COUNT(*) as count FROM items').get();
        if (countRow.count === 0) {
            const insertItem = db.prepare(`
                INSERT INTO items (name, category, type, price, cost, barcode, stock, min_stock)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            insertItem.run("Photocopy (A4)", "Service", "service", 10, 2, "SERV001", 0, 0);
            insertItem.run("Passport Photo", "Studio", "service", 350, 50, "SERV002", 0, 0);
            insertItem.run("Tempered Glass", "Accessories", "product", 500, 150, "ACC001", 25, 5);
            insertItem.run("CR Books", "Stationery", "product", 250, 180, "STAT001", 50, 10);
            console.log('✅ Default sample items created in database.');
        }

        // Seed default shop settings if not exist
        const setStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
        setStmt.run('shop_name', 'Krishan Communication & Studio');
        setStmt.run('owner_name', 'Krishan Kavindu');
        setStmt.run('phone', '076 928 1880 / 071 759 7335');
        setStmt.run('address', 'Hatharamanhandiya, Mapalassa, Sooriyawewa');
    } else if (jsonDb) {
        // Fallback JSON seed
        if (!jsonDb.data.users.find(u => u.username === 'admin')) {
            jsonDb.data.users.push({
                id: 1,
                username: 'admin',
                password_hash: bcrypt.hashSync('admin123', 10),
                role: 'admin',
                name: 'Administrator',
                created_at: new Date().toISOString()
            });
            jsonDb.save();
            console.log('✅ Default Admin created in JSON store: username=admin, password=admin123');
        }
        if (jsonDb.data.items.length === 0) {
            jsonDb.data.items = [
                { id: 1, name: "Photocopy (A4)", category: "Service", type: "service", price: 10, cost: 2, barcode: "SERV001", stock: 0, min_stock: 0 },
                { id: 2, name: "Passport Photo", category: "Studio", type: "service", price: 350, cost: 50, barcode: "SERV002", stock: 0, min_stock: 0 },
                { id: 3, name: "Tempered Glass", category: "Accessories", type: "product", price: 500, cost: 150, barcode: "ACC001", stock: 25, min_stock: 5 },
                { id: 4, name: "CR Books", category: "Stationery", type: "product", price: 250, cost: 180, barcode: "STAT001", stock: 50, min_stock: 10 }
            ];
            jsonDb.save();
        }
    }
}

// Data Access Layer Object
const dbService = {
    // USERS
    getUsers: () => {
        if (db) {
            return db.prepare('SELECT id, username, role, name, created_at FROM users ORDER BY id ASC').all();
        }
        return jsonDb.data.users.map(({ password_hash, ...u }) => u);
    },
    getUserByUsername: (username) => {
        if (db) {
            return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        }
        return jsonDb.data.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    },
    getUserById: (id) => {
        if (db) {
            return db.prepare('SELECT id, username, role, name, created_at FROM users WHERE id = ?').get(id);
        }
        const u = jsonDb.data.users.find(x => x.id === Number(id));
        if (!u) return null;
        const { password_hash, ...rest } = u;
        return rest;
    },
    createUser: ({ username, password, role, name }) => {
        const password_hash = bcrypt.hashSync(password, 10);
        const created_at = new Date().toISOString();
        if (db) {
            const stmt = db.prepare(`
                INSERT INTO users (username, password_hash, role, name, created_at)
                VALUES (?, ?, ?, ?, ?)
            `);
            const res = stmt.run(username.trim(), password_hash, role || 'cashier', name.trim(), created_at);
            return { id: Number(res.lastInsertRowid), username, role, name, created_at };
        }
        const newId = jsonDb.data.users.length ? Math.max(...jsonDb.data.users.map(u => u.id)) + 1 : 1;
        const newUser = { id: newId, username: username.trim(), password_hash, role: role || 'cashier', name: name.trim(), created_at };
        jsonDb.data.users.push(newUser);
        jsonDb.save();
        const { password_hash: _, ...rest } = newUser;
        return rest;
    },
    updateUser: (id, { name, role, password }) => {
        if (db) {
            if (password) {
                const password_hash = bcrypt.hashSync(password, 10);
                db.prepare('UPDATE users SET name = ?, role = ?, password_hash = ? WHERE id = ?').run(name, role, password_hash, id);
            } else {
                db.prepare('UPDATE users SET name = ?, role = ? WHERE id = ?').run(name, role, id);
            }
            return dbService.getUserById(id);
        }
        const user = jsonDb.data.users.find(u => u.id === Number(id));
        if (!user) return null;
        if (name) user.name = name;
        if (role) user.role = role;
        if (password) user.password_hash = bcrypt.hashSync(password, 10);
        jsonDb.save();
        return dbService.getUserById(id);
    },
    deleteUser: (id) => {
        if (db) {
            db.prepare('DELETE FROM users WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.users = jsonDb.data.users.filter(u => u.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // ITEMS / INVENTORY
    getItems: () => {
        if (db) {
            return db.prepare('SELECT id, name, barcode, category, type, price, cost, stock, min_stock as minStock FROM items ORDER BY id DESC').all();
        }
        return [...jsonDb.data.items].reverse();
    },
    getItemById: (id) => {
        if (db) {
            return db.prepare('SELECT id, name, barcode, category, type, price, cost, stock, min_stock as minStock FROM items WHERE id = ?').get(id);
        }
        return jsonDb.data.items.find(i => i.id === Number(id));
    },
    createItem: (item) => {
        if (db) {
            const stmt = db.prepare(`
                INSERT INTO items (name, barcode, category, type, price, cost, stock, min_stock)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(item.name, item.barcode || '', item.category || 'General', item.type || 'product', item.price || 0, item.cost || 0, item.stock || 0, item.minStock || 0);
            return { id: Number(res.lastInsertRowid), ...item };
        }
        const newId = jsonDb.data.items.length ? Math.max(...jsonDb.data.items.map(i => i.id)) + 1 : 1;
        const newItem = { id: newId, ...item };
        jsonDb.data.items.push(newItem);
        jsonDb.save();
        return newItem;
    },
    updateItem: (id, item) => {
        if (db) {
            db.prepare(`
                UPDATE items SET name = ?, barcode = ?, category = ?, type = ?, price = ?, cost = ?, stock = ?, min_stock = ?
                WHERE id = ?
            `).run(item.name, item.barcode || '', item.category, item.type, item.price, item.cost, item.stock, item.minStock || 0, id);
            return { id: Number(id), ...item };
        }
        const idx = jsonDb.data.items.findIndex(i => i.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.items[idx] = { ...jsonDb.data.items[idx], ...item };
            jsonDb.save();
            return jsonDb.data.items[idx];
        }
        return null;
    },
    deleteItem: (id) => {
        if (db) {
            db.prepare('DELETE FROM items WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.items = jsonDb.data.items.filter(i => i.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // SALES
    getSales: () => {
        if (db) {
            const rows = db.prepare('SELECT * FROM sales ORDER BY id DESC').all();
            return rows.map(r => ({
                id: r.id,
                date: r.date,
                total: r.total,
                discount: r.discount,
                paymentMethod: r.payment_method,
                cashReceived: r.cash_received,
                change: r.change_amount,
                items: JSON.parse(r.items_json || '[]'),
                customerName: r.customer_name,
                customerPhone: r.customer_phone,
                userId: r.user_id,
                isUtility: Boolean(r.is_utility)
            }));
        }
        return [...jsonDb.data.sales].reverse();
    },
    createSale: (sale) => {
        const itemsJson = JSON.stringify(sale.items || []);
        if (db) {
            const stmt = db.prepare(`
                INSERT INTO sales (date, total, discount, payment_method, cash_received, change_amount, items_json, customer_name, customer_phone, user_id, is_utility)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                sale.date || new Date().toISOString(),
                sale.total,
                sale.discount || 0,
                sale.paymentMethod || 'cash',
                sale.cashReceived || 0,
                sale.change || 0,
                itemsJson,
                sale.customerName || '',
                sale.customerPhone || '',
                sale.userId || null,
                sale.isUtility ? 1 : 0
            );
            const saleId = Number(res.lastInsertRowid);

            // Deduct stock for inventory product items
            if (sale.items && Array.isArray(sale.items)) {
                for (const item of sale.items) {
                    if (item.type === 'product' && item.id) {
                        db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(item.qty || 1, item.id);
                    }
                }
            }
            return { id: saleId, ...sale };
        }

        const newId = jsonDb.data.sales.length ? Math.max(...jsonDb.data.sales.map(s => s.id)) + 1 : 1;
        const newSale = { id: newId, ...sale };
        jsonDb.data.sales.push(newSale);

        // Deduct stock
        if (sale.items && Array.isArray(sale.items)) {
            for (const item of sale.items) {
                if (item.type === 'product' && item.id) {
                    const found = jsonDb.data.items.find(i => i.id === item.id);
                    if (found) found.stock = Math.max(0, found.stock - (item.qty || 1));
                }
            }
        }
        jsonDb.save();
        return newSale;
    },

    // REPAIRS
    getRepairs: () => {
        if (db) {
            const rows = db.prepare('SELECT * FROM repairs ORDER BY id DESC').all();
            return rows.map(r => ({
                id: r.id,
                customerName: r.customer_name,
                phoneModel: r.phone_model,
                issue: r.issue,
                estimatedCost: r.estimated_cost,
                advancePayment: r.advance_payment,
                status: r.status,
                contact: r.contact,
                createdAt: r.created_at
            }));
        }
        return [...jsonDb.data.repairs].reverse();
    },
    createRepair: (repair) => {
        if (db) {
            const stmt = db.prepare(`
                INSERT INTO repairs (customer_name, phone_model, issue, estimated_cost, advance_payment, status, contact, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                repair.customerName,
                repair.phoneModel,
                repair.issue || '',
                repair.estimatedCost || 0,
                repair.advancePayment || 0,
                repair.status || 'pending',
                repair.contact || '',
                repair.createdAt || new Date().toISOString()
            );
            return { id: Number(res.lastInsertRowid), ...repair };
        }
        const newId = jsonDb.data.repairs.length ? Math.max(...jsonDb.data.repairs.map(r => r.id)) + 1 : 1;
        const newRepair = { id: newId, ...repair };
        jsonDb.data.repairs.push(newRepair);
        jsonDb.save();
        return newRepair;
    },
    updateRepair: (id, repair) => {
        if (db) {
            db.prepare(`
                UPDATE repairs SET customer_name = ?, phone_model = ?, issue = ?, estimated_cost = ?, advance_payment = ?, status = ?, contact = ?
                WHERE id = ?
            `).run(repair.customerName, repair.phoneModel, repair.issue, repair.estimatedCost, repair.advancePayment, repair.status, repair.contact, id);
            return { id: Number(id), ...repair };
        }
        const idx = jsonDb.data.repairs.findIndex(r => r.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.repairs[idx] = { ...jsonDb.data.repairs[idx], ...repair };
            jsonDb.save();
            return jsonDb.data.repairs[idx];
        }
        return null;
    },
    deleteRepair: (id) => {
        if (db) {
            db.prepare('DELETE FROM repairs WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.repairs = jsonDb.data.repairs.filter(r => r.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // EXPENSES
    getExpenses: () => {
        if (db) {
            return db.prepare('SELECT * FROM expenses ORDER BY id DESC').all();
        }
        return [...jsonDb.data.expenses].reverse();
    },
    createExpense: (expense) => {
        if (db) {
            const stmt = db.prepare('INSERT INTO expenses (date, category, amount, description) VALUES (?, ?, ?, ?)');
            const res = stmt.run(expense.date || new Date().toISOString(), expense.category, expense.amount, expense.description || '');
            return { id: Number(res.lastInsertRowid), ...expense };
        }
        const newId = jsonDb.data.expenses.length ? Math.max(...jsonDb.data.expenses.map(e => e.id)) + 1 : 1;
        const newExp = { id: newId, ...expense };
        jsonDb.data.expenses.push(newExp);
        jsonDb.save();
        return newExp;
    },
    deleteExpense: (id) => {
        if (db) {
            db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.expenses = jsonDb.data.expenses.filter(e => e.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // CREDITORS / CUSTOMER DUES
    getCreditors: () => {
        if (db) {
            const rows = db.prepare('SELECT id, name, phone, amount, type, last_updated as lastUpdated FROM creditors ORDER BY id DESC').all();
            return rows;
        }
        return [...jsonDb.data.creditors].reverse();
    },
    createCreditor: (creditor) => {
        if (db) {
            const stmt = db.prepare('INSERT INTO creditors (name, phone, amount, type, last_updated) VALUES (?, ?, ?, ?, ?)');
            const res = stmt.run(creditor.name, creditor.phone || '', creditor.amount || 0, creditor.type || 'receivable', creditor.lastUpdated || new Date().toISOString());
            return { id: Number(res.lastInsertRowid), ...creditor };
        }
        const newId = jsonDb.data.creditors.length ? Math.max(...jsonDb.data.creditors.map(c => c.id)) + 1 : 1;
        const newCred = { id: newId, ...creditor };
        jsonDb.data.creditors.push(newCred);
        jsonDb.save();
        return newCred;
    },
    updateCreditor: (id, creditor) => {
        if (db) {
            db.prepare('UPDATE creditors SET name = ?, phone = ?, amount = ?, type = ?, last_updated = ? WHERE id = ?')
                .run(creditor.name, creditor.phone || '', creditor.amount, creditor.type, new Date().toISOString(), id);
            return { id: Number(id), ...creditor };
        }
        const idx = jsonDb.data.creditors.findIndex(c => c.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.creditors[idx] = { ...jsonDb.data.creditors[idx], ...creditor, lastUpdated: new Date().toISOString() };
            jsonDb.save();
            return jsonDb.data.creditors[idx];
        }
        return null;
    },
    deleteCreditor: (id) => {
        if (db) {
            db.prepare('DELETE FROM creditors WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.creditors = jsonDb.data.creditors.filter(c => c.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // BANK TRANSACTIONS
    getBankTransactions: () => {
        if (db) {
            return db.prepare('SELECT * FROM bank_transactions ORDER BY id DESC').all();
        }
        return [...jsonDb.data.bank_transactions].reverse();
    },
    createBankTransaction: (tx) => {
        if (db) {
            const stmt = db.prepare('INSERT INTO bank_transactions (date, type, amount, note) VALUES (?, ?, ?, ?)');
            const res = stmt.run(tx.date || new Date().toISOString(), tx.type, tx.amount, tx.note || '');
            return { id: Number(res.lastInsertRowid), ...tx };
        }
        const newId = jsonDb.data.bank_transactions.length ? Math.max(...jsonDb.data.bank_transactions.map(b => b.id)) + 1 : 1;
        const newTx = { id: newId, ...tx };
        jsonDb.data.bank_transactions.push(newTx);
        jsonDb.save();
        return newTx;
    },
    deleteBankTransaction: (id) => {
        if (db) {
            db.prepare('DELETE FROM bank_transactions WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.bank_transactions = jsonDb.data.bank_transactions.filter(b => b.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // SUPPLIERS
    getSuppliers: () => {
        if (db) {
            return db.prepare('SELECT * FROM suppliers ORDER BY id DESC').all();
        }
        return [...jsonDb.data.suppliers].reverse();
    },
    createSupplier: (supplier) => {
        if (db) {
            const stmt = db.prepare('INSERT INTO suppliers (name, company, phone, address) VALUES (?, ?, ?, ?)');
            const res = stmt.run(supplier.name, supplier.company || '', supplier.phone || '', supplier.address || '');
            return { id: Number(res.lastInsertRowid), ...supplier };
        }
        const newId = jsonDb.data.suppliers.length ? Math.max(...jsonDb.data.suppliers.map(s => s.id)) + 1 : 1;
        const newSup = { id: newId, ...supplier };
        jsonDb.data.suppliers.push(newSup);
        jsonDb.save();
        return newSup;
    },
    deleteSupplier: (id) => {
        if (db) {
            db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.suppliers = jsonDb.data.suppliers.filter(s => s.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // PURCHASE BILLS
    getPurchaseBills: () => {
        if (db) {
            const rows = db.prepare('SELECT id, supplier_id as supplierId, supplier_name as supplierName, date, total, status, items_json as itemsJson FROM purchase_bills ORDER BY id DESC').all();
            return rows.map(r => ({ ...r, items: JSON.parse(r.itemsJson || '[]') }));
        }
        return [...jsonDb.data.purchase_bills].reverse();
    },
    createPurchaseBill: (bill) => {
        const itemsJson = JSON.stringify(bill.items || []);
        if (db) {
            const stmt = db.prepare('INSERT INTO purchase_bills (supplier_id, supplier_name, date, total, status, items_json) VALUES (?, ?, ?, ?, ?, ?)');
            const res = stmt.run(bill.supplierId || null, bill.supplierName || '', bill.date || new Date().toISOString(), bill.total || 0, bill.status || 'pending', itemsJson);
            return { id: Number(res.lastInsertRowid), ...bill };
        }
        const newId = jsonDb.data.purchase_bills.length ? Math.max(...jsonDb.data.purchase_bills.map(p => p.id)) + 1 : 1;
        const newBill = { id: newId, ...bill };
        jsonDb.data.purchase_bills.push(newBill);
        jsonDb.save();
        return newBill;
    },

    // SETTINGS
    getSettings: () => {
        if (db) {
            const rows = db.prepare('SELECT * FROM settings').all();
            const obj = {};
            for (const r of rows) obj[r.key] = r.value;
            return obj;
        }
        return jsonDb.data.settings;
    },
    setSetting: (key, value) => {
        if (db) {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
            return true;
        }
        jsonDb.data.settings[key] = String(value);
        jsonDb.save();
        return true;
    },

    // EXPORT ALL DATA
    exportAllData: () => {
        return {
            users: dbService.getUsers(),
            items: dbService.getItems(),
            repairs: dbService.getRepairs(),
            sales: dbService.getSales(),
            expenses: dbService.getExpenses(),
            creditors: dbService.getCreditors(),
            bankTransactions: dbService.getBankTransactions(),
            suppliers: dbService.getSuppliers(),
            purchaseBills: dbService.getPurchaseBills(),
            settings: dbService.getSettings(),
            exportTimestamp: new Date().toISOString()
        };
    }
};

// Run table creation on start
initDatabase();

module.exports = { dbService };
