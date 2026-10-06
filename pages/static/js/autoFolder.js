import { store } from './storage.js';
import { MAX_FOLDER_DEPTH, AUTO_FOLDER_MAX_CHATS } from './config.js';

export const AUTO_FOLDER_SYSTEM_PROMPT = `You are an intelligent organization assistant. Your task is to organize unsorted conversations into folders based on existing folder hierarchy, naming conventions, and conversation topics.

Rules:
1. Mimic the naming conventions, casing, language, separators, and style of the existing folders.
2. You can use existing folders (using their exact folder id) or create new folders (using temporary IDs like "n1", "n2", etc.).
3. You can create subfolders inside existing folders or inside other new folders by setting "parent" to the existing folder id or a new folder's temporary id. Set "parent": null for root folders.
4. Assign chats to folders by their index number: { "chat": <index>, "folder": <folder_id_or_temp_id> }.
5. ONLY sort chats that clearly fit into a folder or a newly created relevant folder. Do NOT force chats into inappropriate folders. Unsorted or standalone chats should simply be OMITTED from the "assignments" list.
6. Existing folders and their existing chats are provided for context and style matching ONLY. Do not sort or move existing chats.
7. Output STRICTLY valid JSON matching the following schema without any markdown wrapping or preamble:
{
  "new_folders": [
    { "id": "n1", "name": "Folder Name", "parent": null },
    { "id": "n2", "name": "Subfolder Name", "parent": "n1" }
  ],
  "assignments": [
    { "chat": 0, "folder": "folder_123" },
    { "chat": 1, "folder": "n2"
  ]
}`;

/**
 * A conversation qualifies as named if it has an explicit custom name or was auto-named.
 * Placeholder "New Chat" or default sliced first-turn titles are ignored.
 */
export function isNamedConversation(conv) {
    if (!conv || typeof conv.title !== 'string') return false;
    if (conv.isCustomName === true || conv.isAutoNamed === true) return true;
    if (conv.title === 'New Chat') return false;

    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const firstUser = messages.find(m => m && m.role === 'user');
    if (!firstUser || typeof firstUser.content !== 'string') return false;

    const sliced = firstUser.content.slice(0, 30);
    const expected = sliced + (firstUser.content.length > 30 ? '...' : '');
    if (conv.title === expected) return false;

    return true;
}

/**
 * Returns named chats that are not in any folder or have an invalid/dangling folder ID.
 */
export function buildUnsortedChats(folders, conversations) {
    const folderIdSet = new Set((folders || []).map(f => f.id));
    const unsorted = [];

    (conversations || []).forEach((conv) => {
        if (!isNamedConversation(conv)) return;
        if (!conv.folderId || !folderIdSet.has(conv.folderId)) {
            unsorted.push({
                id: conv.id,
                title: conv.title
            });
        }
    });

    return unsorted.slice(0, AUTO_FOLDER_MAX_CHATS);
}

/**
 * Builds a nested snapshot of existing folders and the titles of chats currently inside them.
 */
export function buildFolderSnapshot(folders, conversations, parentId = null, depth = 0) {
    if (depth > MAX_FOLDER_DEPTH) return [];
    const currentFolders = (folders || []).filter(f => (f.parentId || null) === (parentId || null));

    return currentFolders.map(f => {
        const insideChats = (conversations || [])
            .filter(c => c.folderId === f.id)
            .map(c => c.title);

        return {
            id: f.id,
            name: f.name,
            parentId: f.parentId || null,
            chats: insideChats,
            subfolders: buildFolderSnapshot(folders, conversations, f.id, depth + 1)
        };
    });
}

function formatFolderTreeText(nodes, indent = '') {
    let text = '';
    nodes.forEach(node => {
        text += `${indent}- [ID: ${node.id}] Folder: "${node.name}"\n`;
        if (Array.isArray(node.chats) && node.chats.length > 0) {
            node.chats.forEach(title => {
                text += `${indent}    * Chat (read-only): "${title}"\n`;
            });
        }
        if (Array.isArray(node.subfolders) && node.subfolders.length > 0) {
            text += formatFolderTreeText(node.subfolders, indent + '  ');
        }
    });
    return text;
}

/**
 * Builds the user prompt detailing the folder structure and the numbered list of chats.
 */
export function buildAutoFolderPrompt(snapshot, unsortedChats) {
    let prompt = 'CURRENT FOLDER STRUCTURE AND CONTENTS (FOR CONTEXT ONLY, DO NOT MOVE EXISTING CHATS):\n';
    if (snapshot.length === 0) {
        prompt += '(No folders exist yet)\n';
    } else {
        prompt += formatFolderTreeText(snapshot);
    }

    prompt += '\nUNSORTED CHATS TO ORGANIZE (REFERENCE BY INDEX):\n';
    unsortedChats.forEach((chat, index) => {
        prompt += `[${index}] "${chat.title}"\n`;
    });

    prompt += '\nProvide the JSON payload assigning chats to existing or new folders.';
    return prompt;
}
