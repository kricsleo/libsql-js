import test from "ava";
import crypto from 'crypto';
import fs from 'fs';

test.beforeEach(async (t) => {
    const [db, errorType, path] = await connect();
    
    await db.exec(`
      DROP TABLE IF EXISTS users;
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT)
  `);
    const aliceId = generateUUID();
    const bobId = generateUUID();
    await db.exec(
        `INSERT INTO users (id, name, email) VALUES ('${aliceId}', 'Alice', 'alice@example.org')`
    );
    await db.exec(
        `INSERT INTO users (id, name, email) VALUES ('${bobId}', 'Bob', 'bob@example.com')`
    );
    t.context = {
        db,
        errorType,
        aliceId,
        bobId,
        path
    };
});

test("Concurrent reads", async (t) => {
    const db = t.context.db;
    const stmt = await db.prepare("SELECT * FROM users WHERE id = ?");

    const promises = [];
    for (let i = 0; i < 100; i++) {
        promises.push(stmt.get(t.context.aliceId));
        promises.push(stmt.get(t.context.bobId));
    }

    const results = await Promise.all(promises);

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        t.truthy(result);
        t.is(typeof result.name, 'string');
        t.is(typeof result.email, 'string');
    }
    cleanup(t.context);
});

test("Concurrent writes", async (t) => {
    const db = t.context.db;

    await db.exec(`
    DROP TABLE IF EXISTS concurrent_users;
    CREATE TABLE concurrent_users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT
    )
  `);

    const stmt = await db.prepare("INSERT INTO concurrent_users(id, name, email) VALUES (:id, :name, :email)");

    const promises = [];
    for (let i = 0; i < 50; i++) {
        promises.push(stmt.run({
            id: generateUUID(),
            name: `User${i}`,
            email: `user${i}@example.com`
        }));
    }

    await Promise.all(promises);

    const countStmt = await db.prepare("SELECT COUNT(*) as count FROM concurrent_users");
    const result = await countStmt.get();
    t.is(result.count, 50);

    cleanup(t.context);
});

test("Concurrent transaction isolation", async (t) => {
    const db = t.context.db;

    await db.exec(`
    DROP TABLE IF EXISTS transaction_users;
    CREATE TABLE transaction_users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT
    )
  `);

    const aliceId = generateUUID();
    const bobId = generateUUID();

    await db.exec(`
    INSERT INTO transaction_users (id, name, email) VALUES 
    ('${aliceId}', 'Alice', 'alice@example.org'),
    ('${bobId}', 'Bob', 'bob@example.com')
  `);

    const updateUser = db.transaction(async (id, name, email) => {
        const stmt = await db.prepare("UPDATE transaction_users SET name = :name, email = :email WHERE id = :id");
        await stmt.run({ id, name, email });
    });

    const promises = [];
    for (let i = 0; i < 10; i++) {
        promises.push(updateUser(aliceId, `Alice${i}`, `alice${i}@example.org`));
        promises.push(updateUser(bobId, `Bob${i}`, `bob${i}@example.com`));
    }

    await Promise.all(promises);

    const stmt = await db.prepare("SELECT * FROM transaction_users ORDER BY name");
    const results = await stmt.all();
    t.is(results.length, 2);
    t.truthy(results[0].name.startsWith('Alice'));
    t.truthy(results[1].name.startsWith('Bob'));

    cleanup(t.context);
});

test("Concurrent reads and writes", async (t) => {
    const db = t.context.db;

    await db.exec(`
    DROP TABLE IF EXISTS mixed_users;
    CREATE TABLE mixed_users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT
    )
  `);

    const aliceId = generateUUID();
    await db.exec(`
    INSERT INTO mixed_users (id, name, email) VALUES 
    ('${aliceId}', 'Alice', 'alice@example.org')
  `);

    const readStmt = await db.prepare("SELECT * FROM mixed_users WHERE id = ?");
    const writeStmt = await db.prepare("INSERT INTO mixed_users(id, name, email) VALUES (:id, :name, :email)");

    const promises = [];
    for (let i = 0; i < 20; i++) {
        promises.push(readStmt.get(aliceId));
        writeStmt.run({
            id: generateUUID(),
            name: `User${i}`,
            email: `user${i}@example.com`
        });
    }
    await Promise.all(promises);

    const countStmt = await db.prepare("SELECT COUNT(*) as count FROM mixed_users");
    const result = await countStmt.get();
    t.is(result.count, 21); // 1 initial + 20 new records

    await cleanup(t.context);
});

test("Concurrent operations with timeout should handle busy database", async (t) => {
    const timeout = 1000;
    const path = `test-${crypto.randomBytes(8).toString('hex')}.db`;
    const [conn1] = await connect(path);
    const [conn2] = await connect(path, { timeout });

    await conn1.exec("CREATE TABLE t(id TEXT PRIMARY KEY, x INTEGER)");
    await conn1.exec("BEGIN IMMEDIATE");
    await conn1.exec(`INSERT INTO t VALUES ('${generateUUID()}', 1)`);

    const start = Date.now();
    try {
        await conn2.exec(`INSERT INTO t VALUES ('${generateUUID()}', 2)`);
        t.fail("Should have thrown SQLITE_BUSY error");
    } catch (e) {
        t.is(e.code, "SQLITE_BUSY");
        const end = Date.now();
        const elapsed = end - start;
        t.true(elapsed > timeout / 2, "Timeout should be respected");
    }

    conn1.close();
    conn2.close();
    // FIXME: Fails on Windows because file is still busy.
    // fs.unlinkSync(path);
});  


const connect = async (path_opt, options = {}) => {
    const path = path_opt ?? `test-${crypto.randomBytes(8).toString('hex')}.db`;
    const x = await import("libsql/promise");
    const db = new x.default(process.env.LIBSQL_DATABASE ?? path, options);
    return [db, x.SqliteError, path];
};

const cleanup = async (context) => {
    context.db.close();
    // FIXME: Fails on Windows because file is still busy.
    // fs.unlinkSync(context.path);
};

const generateUUID = () => {
    return crypto.randomUUID();
};
