const { logMessage } = require('./misc/logger');

module.exports = db_ast_to_exportable_ast;

function db_ast_to_exportable_ast ({ tables }) {
    logMessage(`Generating exportable PostgreSQL AST structure...`);
    structure = tables.map(mapTables);
    logMessage(`PostgreSQL AST structure generation finished.`);
    return structure;
}

function mapTables (table) {
    return {
        identifier: table.identifier,
        columns: table.columns
            .map(mapType)
    };
}

function mapType (type) {
    return Object.assign({
        identifier: type.identifier
    }, resolveType(type.referencedType));
}

function resolveType (referencedType) {   
    switch (referencedType.type) {
        case 'SQLType':
            return {
                type: 'Structure',
                members: referencedType.members
                    .map(mapType)
            };
        case 'SQLEnumeratedType':
            return { type: 'Enumerated' };
        case 'SQLTypeReference':
            return resolveType(referencedType.referencedType);
        case 'BitString':
            if (referencedType.referencedType !== undefined) {
                return Object.assign(resolveType(referencedType.referencedType),
                    { type: 'BitString' });
            }
        case 'TableReference':
            return {
                type: 'TableReference',
                references: referencedType.tableIdentifiers
            };
        case 'TypedCollection':
            return {
                type: 'TypedCollection',
                subtype: resolveType(referencedType.referencedType)
            };
        default:
            return { type: referencedType.type };
    }
}