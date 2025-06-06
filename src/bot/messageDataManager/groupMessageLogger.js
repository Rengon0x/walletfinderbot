const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
// Constantes
const BASE_PATH = path.resolve(__dirname, '..');
const GROUP_MESSAGES_FILE = path.join(BASE_PATH, 'data', 'group_messages.json');

// Expressions régulières pour détecter les adresses Solana et Ethereum
const SOLANA_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const ETHEREUM_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/;

// Fonction pour vérifier si un message contient une adresse valide
function containsValidAddress(text) {
  return SOLANA_ADDRESS_REGEX.test(text) || ETHEREUM_ADDRESS_REGEX.test(text);
}

// Fonction pour enregistrer un message de groupe contenant une adresse valide
function logGroupMessage(msg) {
  try {
    // Vérifie si le message et son texte existent
    if (!msg || !msg.text) {
      logger.warn('Received empty message or message without text');
      return;
    }

    if (!containsValidAddress(msg.text)) {
      return; // Ne pas enregistrer si le message ne contient pas d'adresse valide
    }

    const messageData = {
      userId: msg.from.id,
      username: msg.from.username,
      firstName: msg.from.first_name,
      lastName: msg.from.last_name,
      chatId: msg.chat.id,
      chatTitle: msg.chat.title,
      date: new Date(msg.date * 1000).toISOString(),
      text: msg.text
    };

    let messages = [];
    if (fs.existsSync(GROUP_MESSAGES_FILE)) {
      try {
        const data = fs.readFileSync(GROUP_MESSAGES_FILE, 'utf8');
        // Vérifie si le fichier n'est pas vide avant de parser
        if (data.trim()) {
          messages = JSON.parse(data);
        }
      } catch (parseError) {
        logger.error('Error parsing existing messages file:', parseError);
        // Si le fichier est corrompu, on commence avec un tableau vide
        messages = [];
      }
    }

    messages.push(messageData);

    // Écriture avec gestion d'erreur
    try {
      fs.writeFileSync(GROUP_MESSAGES_FILE, JSON.stringify(messages, null, 2));
      logger.info(`Logged message with valid address from user: ${msg.from.username} in group: ${msg.chat.title}`);
    } catch (writeError) {
      logger.error('Error writing messages file:', writeError);
    }
  } catch (error) {
    logger.error('Error in logGroupMessage:', error);
  }
}

// Fonction d'initialisation pour s'assurer que le dossier 'data' existe
function initialize() {
  const dataDir = path.join(BASE_PATH, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  // Créer un fichier vide si nécessaire avec un tableau JSON vide
  if (!fs.existsSync(GROUP_MESSAGES_FILE)) {
    try {
      fs.writeFileSync(GROUP_MESSAGES_FILE, '[]', 'utf8');
    } catch (error) {
      logger.error('Error creating initial messages file:', error);
    }
  }
}

module.exports = {
  logGroupMessage,
  initialize
};