import {
    store,
    saveConversationToBackend,
    saveIndexToBackend
} from './storage.js';
import { MAX_FOLDER_DEPTH, AUTO_FOLDER_MAX_NEW_FOLDERS } from './config.js';
import { safeJsonParse } from './execution.js';

/**
 * Robustly scans for a JSON object in model output text.
 */
export function extractJsonObject(rawText) {
    if (typeof rawText !== 'string' || !rawText) return null;

    // 1. Try parsing raw text directly or stripping markdown code blocks
    const stripped = rawText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const direct = safeJsonParse(stripped);
    if (direct && typeof direct === 'object') return direct;

    // 2. Scan for outer-most braces
    const start = rawText.indexOf('{');
    const end = rawText.lastIndexOf('}');
    if (start !== -1 && end > start) {
        const parsed = safeJsonParse(rawText.slice(start, end + 1));
        if (parsed && typeof parsed === 'object') return parsed;
    }

    return null;
}

/**
 * Resolves and validates the proposed organization plan against current data.
 */
export function resolvePlan(parsedData, existingFolders, unsortedChats) {
    const rejected = [];
    if (!parsedData || typeof parsedData !== 'object') {
        return {
            newFolders: [],
            moves: [],
            rejected: [{ reason: 'Invalid or missing JSON payload from model' }]
        };
    }

    const existingFolderMap = new Map((existingFolders || []).map(f => [f.id, f]));
    const rawNewFolders = Array.isArray(parsedData.new_folders) ? parsedData.new_folders : [];
    const rawAssignments = Array.isArray(parsedData.assignments) ? parsedData.assignments : [];

    // 1. Validate & resolve new folders
    const newFolderMap = new Map();
    const validTempIds = new Set();

    for (let i = 0; i < rawNewFolders.length; i++) {
        if (newFolderMap.size >= AUTO_FOLDER_MAX_NEW_FOLDERS) {
            rejected.push({ reason: `Exceeded max new folder limit (${AUTO_FOLDER_MAX_NEW_FOLDERS})` });
            break;
        }

        const nf = rawNewFolders[i];
        if (!nf || typeof nf !== 'object') continue;

        const tempId = typeof nf.id === 'string' ? nf.id.trim() : `n${i + 1}`;
        const name = typeof nf.name === 'string' ? nf.name.trim() : '';
        const parent = (typeof nf.parent === 'string' && nf.parent.trim()) ? nf.parent.trim() : null;

        if (!name) {
            rejected.push({ reason: `New folder omitted because name is empty: ${tempId}` });
            continue;
        }

        if (validTempIds.has(tempId)) {
            rejected.push({ reason: `Duplicate new folder ID: ${tempId}` });
            continue;
        }

        // Check if an existing sibling folder already has this name under the same parent
        let matchingExistingId = null;
        for (const [efId, ef] of existingFolderMap.entries()) {
            if ((ef.parentId || null) === parent && ef.name.toLowerCase() === name.toLowerCase()) {
                matchingExistingId = efId;
                break;
            }
        }

        if (matchingExistingId) {
            // Alias the temp ID to the existing folder
            validTempIds.add(tempId);
            newFolderMap.set(tempId, {
                tempId,
                isAlias: true,
                aliasTo: matchingExistingId,
                name: existingFolderMap.get(matchingExistingId).name,
                parent
            });
            continue;
        }

        validTempIds.add(tempId);
        newFolderMap.set(tempId, {
            tempId,
            isAlias: false,
            name,
            parent,
            depth: 0
        });
    }

    // Calculate depth & detect cycles for new folders
    const resolvedNewFolders = new Map();
    for (const [tempId, nf] of newFolderMap.entries()) {
        if (nf.isAlias) {
            resolvedNewFolders.set(tempId, nf);
            continue;
        }

        let currentParent = nf.parent;
        let depth = 0;
        let hasCycle = false;
        const visited = new Set([tempId]);

        while (currentParent && depth <= MAX_FOLDER_DEPTH) {
            if (existingFolderMap.has(currentParent)) {
                // Parent is an existing folder, calculate its ancestors
                let anc = existingFolderMap.get(currentParent);
                let eDepth = 1;
                while (anc && anc.parentId && eDepth <= MAX_FOLDER_DEPTH) {
                    anc = existingFolderMap.get(anc.parentId);
                    eDepth++;
                }
                depth += eDepth;
                break;
            } else if (newFolderMap.has(currentParent)) {
                if (visited.has(currentParent)) {
                    hasCycle = true;
                    break;
                }
                visited.add(currentParent);
                const pObj = newFolderMap.get(currentParent);
                currentParent = pObj.parent;
                depth++;
            } else {
                // Unknown parent ID
                hasCycle = true;
                break;
            }
        }

        if (hasCycle || depth > MAX_FOLDER_DEPTH) {
            rejected.push({ reason: `Folder "${nf.name}" (${tempId}) rejected: cyclic or excessive depth (${depth})` });
        } else {
            nf.depth = depth;
            resolvedNewFolders.set(tempId, nf);
        }
    }

    // 2. Validate assignments
    const moves = [];
    const assignedChatIndices = new Set();
    const folderUsageCount = new Map();

    for (let j = 0; j < rawAssignments.length; j++) {
        const a = rawAssignments[j];
        if (!a || typeof a !== 'object') continue;

        const chatIdx = typeof a.chat === 'number' ? a.chat : parseInt(a.chat, 10);
        if (isNaN(chatIdx) || chatIdx < 0 || chatIdx >= unsortedChats.length) {
            rejected.push({ reason: `Invalid chat index: ${a.chat}` });
            continue;
        }

        if (assignedChatIndices.has(chatIdx)) {
            rejected.push({ reason: `Chat [${chatIdx}] "${unsortedChats[chatIdx].title}" assigned multiple times` });
            continue;
        }

        let targetFolderId = typeof a.folder === 'string' ? a.folder.trim() : '';
        let folderName = '';
        let isNew = false;

        if (existingFolderMap.has(targetFolderId)) {
            folderName = existingFolderMap.get(targetFolderId).name;
        } else if (resolvedNewFolders.has(targetFolderId)) {
            const nf = resolvedNewFolders.get(targetFolderId);
            if (nf.isAlias) {
                targetFolderId = nf.aliasTo;
                folderName = nf.name;
            } else {
                folderName = nf.name;
                isNew = true;
            }
        } else {
            rejected.push({ reason: `Chat [${chatIdx}] "${unsortedChats[chatIdx].title}" targets nonexistent folder: ${targetFolderId}` });
            continue;
        }

        assignedChatIndices.add(chatIdx);
        folderUsageCount.set(targetFolderId, (folderUsageCount.get(targetFolderId) || 0) + 1);

        moves.push({
            chatId: unsortedChats[chatIdx].id,
            chatTitle: unsortedChats[chatIdx].title,
            targetFolderId,
            folderName,
            isNewFolder: isNew
        });
    }

    // 3. Filter out new folders that have 0 assigned chats and no active subfolders
    const finalNewFolders = [];
    for (const [tempId, nf] of resolvedNewFolders.entries()) {
        if (nf.isAlias) continue;

        // Check if this folder or any descendant has assigned chats
        const hasDirectChats = (folderUsageCount.get(tempId) || 0) > 0;
        const hasDescendantChats = Array.from(resolvedNewFolders.values()).some(sub => {
            return sub.parent === tempId && (folderUsageCount.get(sub.tempId) || 0) > 0;
        });

        if (hasDirectChats || hasDescendantChats) {
            finalNewFolders.push(nf);
        } else {
            rejected.push({ reason: `Pruned empty new folder "${nf.name}" (no chats assigned)` });
        }
    }

    return {
        newFolders: finalNewFolders,
        moves,
        rejected
    };
}

/**
 * Applies the verified plan to store and persists to backend.
 */
export function applyPlan(plan) {
    if (!plan || !Array.isArray(plan.moves) || plan.moves.length === 0) return;

    // 1. Create mapping from tempId to permanent real folder IDs
    const tempToRealIdMap = new Map();
    const now = Date.now();

    (plan.newFolders || []).forEach((nf, idx) => {
        const realId = `folder_${now}_${idx}`;
        tempToRealIdMap.set(nf.tempId, realId);
    });

    // 2. Add new folders to store.folders
    (plan.newFolders || []).forEach((nf) => {
        const realId = tempToRealIdMap.get(nf.tempId);
        let realParent = nf.parent;
        if (realParent && tempToRealIdMap.has(realParent)) {
            realParent = tempToRealIdMap.get(realParent);
        }

        store.folders.push({
            id: realId,
            name: nf.name,
            parentId: realParent || null,
            collapsed: false
        });
    });

    // 3. Move conversations
    (plan.moves || []).forEach((move) => {
        let realTargetFolderId = move.targetFolderId;
        if (tempToRealIdMap.has(realTargetFolderId)) {
            realTargetFolderId = tempToRealIdMap.get(realTargetFolderId);
        }

        const conv = store.conversations.find(c => c.id === move.chatId);
        if (conv) {
            conv.folderId = realTargetFolderId;
            saveConversationToBackend(conv);
        }
    });

    saveIndexToBackend();
}
