import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_FILE_OPERATIONS = { rename, rm, writeFile };

/**
 * Replace a file only after its complete contents have been written beside it.
 * Keeping the temporary file in the destination directory makes the final
 * rename atomic on the supported filesystems.
 */
export async function writeFileAtomic(
    target,
    contents,
    encoding = "utf8",
    fileOperations = DEFAULT_FILE_OPERATIONS
) {
    const temporary = join(
        dirname(target),
        `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
    );

    try {
        await fileOperations.writeFile(temporary, contents, encoding);
        await fileOperations.rename(temporary, target);
    } catch (error) {
        try {
            await fileOperations.rm(temporary, { force: true });
        } catch {
            // Preserve the write/rename error that made the operation fail.
        }
        throw error;
    }
}
