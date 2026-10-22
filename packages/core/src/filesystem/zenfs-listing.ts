import { decodeDirListing, encodeDirListing, ErrnoError, Inode, rootIno, StoreFS } from '@zenfs/core';

/**
 * A directory ZenFS keeps is a JSON object, and every place that asks whether a name is in one
 * asks `name in listing` or `listing[name]` -- of a plain object, so a name `Object.prototype`
 * already answers to (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `__proto__`, ...) is
 * "in" every directory whether it is there or not. `mkdir /d1/constructor` then reports EEXIST for
 * a directory that does not exist, a write into it reports ENOENT, and `readdir` -- which reads
 * own names with `Object.keys` -- never shows one. A package that has a directory with such a name
 * cannot be installed: `memoizee` needs `node_modules/type/constructor/is.js`.
 *
 * The package is a dependency and cannot be edited here, so the four places are re-pointed at
 * versions that ask for an own property. Nothing else about a listing changes: an own entry still
 * shadows the inherited one, so a directory that really does hold `constructor` behaves as it did.
 */

/** A listing, and the transaction parts of a store this file has to reach into. */
type Listing = Record<string, bigint>;

interface ListingTransaction {
    get(id: bigint): Promise<Uint8Array>;
    getSync(id: bigint): Uint8Array;
    set(id: bigint, data: Uint8Array): Promise<void>;
    setSync(id: bigint, data: Uint8Array): void;
    commit(): Promise<void>;
    commitSync(): void;
}

/** The members of `StoreFS` a listing edit needs; they are internal to the package. */
interface StoreFsInternals {
    store: { transaction(): ListingTransaction };
    findInode(tx: ListingTransaction, path: string, syscall: string): Promise<Inode>;
    findInodeSync(tx: ListingTransaction, path: string, syscall: string): Inode;
    get(tx: ListingTransaction, id: bigint, path: string, syscall: string): Promise<Uint8Array>;
    getSync(tx: ListingTransaction, id: bigint, path: string, syscall: string): Uint8Array;
}

/** The directory holding `path` and the name in it, split as ZenFS splits them. */
function splitPath(path: string): { dir: string; base: string } {
    const cut = path.lastIndexOf('/');
    return { dir: cut <= 0 ? '/' : path.slice(0, cut), base: path.slice(cut + 1) };
}

function joinPath(dir: string, base: string): string {
    return dir === '/' ? `/${base}` : `${dir}/${base}`;
}

/** Whether a name every plain object inherits answers for, whatever the directory holds. */
function inheritedName(name: string): boolean {
    return name in Object.prototype;
}

function hasOwn(listing: Listing, name: string): boolean {
    return Object.prototype.hasOwnProperty.call(listing, name);
}

let tempCounter = 0;

/** A name no directory can hold already, for the entry this file creates on the way to its real name. */
function tempName(): string {
    tempCounter += 1;
    return `__owc-listing-${tempCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function listingOf(fs: StoreFsInternals, dir: string): Promise<Listing> {
    const tx = fs.store.transaction();
    const parent = dir === '/'
        ? new Inode(await fs.get(tx, rootIno, dir, 'readdir'))
        : await fs.findInode(tx, dir, 'readdir');
    const listing = decodeDirListing(await fs.get(tx, parent.data, dir, 'readdir'));
    await tx.commit();
    return listing;
}

function listingOfSync(fs: StoreFsInternals, dir: string): Listing {
    const tx = fs.store.transaction();
    const parent = dir === '/'
        ? new Inode(fs.getSync(tx, rootIno, dir, 'readdir'))
        : fs.findInodeSync(tx, dir, 'readdir');
    const listing = decodeDirListing(fs.getSync(tx, parent.data, dir, 'readdir'));
    tx.commitSync();
    return listing;
}

/**
 * Puts `name` in a listing. An assignment would not do: `listing['__proto__'] = ino` sets the
 * listing's prototype instead of adding an entry (and drops a bigint on the floor), so the one
 * name a plain object cannot be given by assignment is given here.
 */
function put(listing: Listing, name: string, ino: bigint): void {
    Object.defineProperty(listing, name, { value: ino, writable: true, enumerable: true, configurable: true });
}

/** Moves one entry of a directory's listing to another name, in a transaction of its own. */
async function rekey(fs: StoreFsInternals, dir: string, from: string, to: string): Promise<void> {
    const tx = fs.store.transaction();
    const parent = dir === '/'
        ? new Inode(await fs.get(tx, rootIno, dir, 'rename'))
        : await fs.findInode(tx, dir, 'rename');
    const listing = decodeDirListing(await fs.get(tx, parent.data, dir, 'rename'));
    put(listing, to, listing[from]);
    delete listing[from];
    await tx.set(parent.data, encodeDirListing(listing));
    await tx.commit();
}

function rekeySync(fs: StoreFsInternals, dir: string, from: string, to: string): void {
    const tx = fs.store.transaction();
    const parent = dir === '/'
        ? new Inode(fs.getSync(tx, rootIno, dir, 'rename'))
        : fs.findInodeSync(tx, dir, 'rename');
    const listing = decodeDirListing(fs.getSync(tx, parent.data, dir, 'rename'));
    put(listing, to, listing[from]);
    delete listing[from];
    tx.setSync(parent.data, encodeDirListing(listing));
    tx.commitSync();
}

/** The shape of each `StoreFS` member this file re-points; the package keeps them internal. */
type FindInode = (this: StoreFsInternals, tx: ListingTransaction, path: string, syscall: string, visited?: Set<string>) => Promise<bigint>;
type FindInodeSync = (this: StoreFsInternals, tx: ListingTransaction, path: string, syscall: string, visited?: Set<string>) => bigint;
type CommitNew = (this: StoreFsInternals, path: string, type: number, mode: number, data: Uint8Array, syscall: string) => Promise<Inode>;
type CommitNewSync = (this: StoreFsInternals, path: string, type: number, mode: number, data: Uint8Array, syscall: string) => Inode;
type Rename = (this: StoreFsInternals, oldPath: string, newPath: string) => Promise<void>;
type RenameSync = (this: StoreFsInternals, oldPath: string, newPath: string) => void;

let installed = false;

/**
 * Re-points the four listing sites of `StoreFS`. Called once, before the root is mounted; a second
 * call does nothing, and every `StoreFS` of this page is fixed, whatever store it keeps.
 */
export function installPrototypeNameFix(): void {
    if (installed) return;
    installed = true;
    const proto = StoreFS.prototype as unknown as Record<string, unknown>;

    const findInode = proto._findInode as FindInode;
    const fixedFindInode: FindInode = async function (tx, path, syscall, visited) {
        const { dir, base } = splitPath(path);
        if (!inheritedName(base)) return findInode.call(this, tx, path, syscall, visited);
        const parent = dir === '/'
            ? new Inode(await this.get(tx, rootIno, dir, syscall))
            : await this.findInode(tx, dir, syscall);
        const listing = decodeDirListing(await this.get(tx, parent.data, dir, syscall));
        if (!hasOwn(listing, base)) throw ErrnoError.With('ENOENT', path, syscall);
        return listing[base];
    };

    const findInodeSync = proto._findInodeSync as FindInodeSync;
    const fixedFindInodeSync: FindInodeSync = function (tx, path, syscall, visited) {
        const { dir, base } = splitPath(path);
        if (!inheritedName(base)) return findInodeSync.call(this, tx, path, syscall, visited);
        const parent = dir === '/'
            ? new Inode(this.getSync(tx, rootIno, dir, syscall))
            : this.findInodeSync(tx, dir, syscall);
        const listing = decodeDirListing(this.getSync(tx, parent.data, dir, syscall));
        if (!hasOwn(listing, base)) throw ErrnoError.With('ENOENT', path, syscall);
        return listing[base];
    };

    const commitNew = proto.commitNew as CommitNew;
    const fixedCommitNew: CommitNew = async function (path, type, mode, data, syscall) {
        const { dir, base } = splitPath(path);
        if (!inheritedName(base)) return commitNew.call(this, path, type, mode, data, syscall);
        if (hasOwn(await listingOf(this, dir), base)) throw ErrnoError.With('EEXIST', path, syscall);
        /* The name the package checks is inherited, so the entry is committed under one it does
           not check and moved to its real name afterwards. */
        const temp = tempName();
        const inode = await commitNew.call(this, joinPath(dir, temp), type, mode, data, syscall);
        await rekey(this, dir, temp, base);
        return inode;
    };

    const commitNewSync = proto.commitNewSync as CommitNewSync;
    const fixedCommitNewSync: CommitNewSync = function (path, type, mode, data, syscall) {
        const { dir, base } = splitPath(path);
        if (!inheritedName(base)) return commitNewSync.call(this, path, type, mode, data, syscall);
        if (hasOwn(listingOfSync(this, dir), base)) throw ErrnoError.With('EEXIST', path, syscall);
        const temp = tempName();
        const inode = commitNewSync.call(this, joinPath(dir, temp), type, mode, data, syscall);
        rekeySync(this, dir, temp, base);
        return inode;
    };

    const rename = proto.rename as Rename;
    const fixedRename: Rename = async function (oldPath, newPath) {
        const { dir, base } = splitPath(newPath);
        /* An own entry of the new name shadows the inherited one and the package's own check
           reads it, so only a new name nothing holds has to be routed. */
        if (!inheritedName(base) || hasOwn(await listingOf(this, dir), base)) {
            return rename.call(this, oldPath, newPath);
        }
        const temp = tempName();
        await rename.call(this, oldPath, joinPath(dir, temp));
        await rekey(this, dir, temp, base);
    };

    const renameSync = proto.renameSync as RenameSync;
    const fixedRenameSync: RenameSync = function (oldPath, newPath) {
        const { dir, base } = splitPath(newPath);
        if (!inheritedName(base) || hasOwn(listingOfSync(this, dir), base)) {
            return renameSync.call(this, oldPath, newPath);
        }
        const temp = tempName();
        renameSync.call(this, oldPath, joinPath(dir, temp));
        rekeySync(this, dir, temp, base);
    };

    proto._findInode = fixedFindInode;
    proto._findInodeSync = fixedFindInodeSync;
    proto.commitNew = fixedCommitNew;
    proto.commitNewSync = fixedCommitNewSync;
    proto.rename = fixedRename;
    proto.renameSync = fixedRenameSync;
}
