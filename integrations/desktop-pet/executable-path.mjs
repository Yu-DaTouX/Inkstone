import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
function fileExists(p) {
    try {
        return statSync(p).isFile();
    }
    catch {
        return false;
    }
}
export function findExecutableOnPath(name) {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const names = process.platform === 'win32'
        ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean)
            .map((ext) => name + ext.toLowerCase())
        : [name];
    for (const dir of dirs) {
        for (const candidate of names) {
            const p = join(dir, candidate);
            if (fileExists(p))
                return p;
        }
    }
    return null;
}
