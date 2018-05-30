const dateString = buildDateString(new Date()),
directoryPath = './tmp',
filePath = `${directoryPath}/${dateString}.log`,
fs = require('fs');

if (!fs.existsSync(`${directoryPath}`)) {
    console.log(`No log directory detected. Creating ${directoryPath}.`);
    fs.mkdirSync(`${directoryPath}`);
} else if (!fs.statSync(`${directoryPath}`).isDirectory()) {
    throw new Error(`The path ${directoryPath} is reserved for the log files. Please, remove that file and try again.`);
}

module.exports = {
    logMessage: logMessage,
    logError: logError,
    logUncompilableType: logUncompilableType,
    logUnreferencedType: logUnreferencedType
};

function generalLog (message) {
    if (message === '') {
        return;
    }

    console.log(message);
    fs.appendFileSync(filePath, `${message}\n`);
}

function logMessage (message) {
    generalLog(buildDatedTag('Info') + message);
}

function logError (message) {
    generalLog(buildDatedTag('Error') + message);
}

function logUncompilableType (declaration) {
    logError(`Piece of ASN can't be compiled to any type: ${declaration}.`);
}

function logUnreferencedType (declaration) {
    logError(`Cannot find any type named ${declaration}.`);
}

function buildDatedTag (tag) {
    return `[${(new Date()).toLocaleString()}][${tag}]: `;
}

function buildDateString (date) {
    return date.toISOString().slice(0, 16);
}