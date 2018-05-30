const {
    logMessage,
    logError
} = require('./misc/logger'),
{
    capitalize,
    extractProperty,
    flattenedFromFunction,
    isBitString,
    isChoice,
    isEnumerated,
    isNull,
    isSequenceOf,
    isSetOf,
    isSQLEnumeratedType,
    isSQLType,
    isSQLTypeReference,
    isTableReference,
    isTypedCollection,
    partialApply,
    pipe
} = require('./misc/util'),
filterElegibleTypesForTables = require('./ast-table-picker'),
{ DepGraph } = require('dependency-graph'),
dependencyGraph = new DepGraph();

module.exports = {
    asnASTToPostgreSQLAST,
    PostgreSQLASTTypes: [
        'BitString',
        'Boolean',
        'Choice',
        'Enumerated',
        'Integer',
        'SQLEnumeratedType',
        'SQLType',
        'String',
        'TableReference',
        'Timestamp',
        'TypedCollection',
        'UUID'
    ]
};

/**
 * @param {object} ast 
 * @return {string}
 */
function asnASTToPostgreSQLAST(ast) {
    logMessage(`Generating DB PostgreSQL AST from ASN AST...`);

    const   elegibleTypesForTables  = filterElegibleTypesForTables(ast),
            tables                  = resolveTables(elegibleTypesForTables);
            createdSQLTypes         = createSQLTypesFromAST(ast, elegibleTypesForTables);

    for (createdSQLType of createdSQLTypes)
        resolveNestedTypesReferences(createdSQLTypes, createdSQLType);
    
    const sqlTypesUsedByColumns = extractSQLTypeReferencesFromTables(tables)
        .map(partialApply(assignProperSQLTypeToType, createdSQLTypes))
        .map(extractProperty('referencedType'))
        .reduce(accumulateRemovingRepeated, []);

    /*
    You may be wondering: why not all created SQL Types are used? Often, an ASN.1 declaration
    contains declared types not used by any other type.
    */
    const usedSQLTypes = getUsedSQLTypesDeeply(sqlTypesUsedByColumns);

    populateGraph(usedSQLTypes);
    const orderedUsedSQLTypes = dependencyGraph
        .overallOrder()
        .map(dependencyIdentifier =>
            usedSQLTypes.find(({ identifier }) => identifier == dependencyIdentifier));

    logMessage(`DB PostgreSQL generation finished.`);
    return {
        tables: tables,
        sqlTypes: orderedUsedSQLTypes
    };

    function populateGraph (types, parentType) {
        for (type of types) {
            if (isTypedCollection(type)) {
                populateGraph([type.referencedType], parentType);
                continue;
            }
            
            if (!isSQLEnumeratedType(type) && !isSQLType(type))
                continue;

            if (dependencyGraph.hasNode(type.identifier))
                continue;

            dependencyGraph.addNode(type.identifier);
            if (parentType)
                dependencyGraph.addDependency(parentType.identifier, type.identifier);

            if (!isSQLEnumeratedType(type))
                populateGraph(
                    type.members
                        .map(extractProperty('referencedType')),
                    type);
        }
    }

    function extractSQLTypeReferencesFromTables (tables) {
        const extractColumns = partialApply(flattenedFromFunction, extractProperty('columns'));
        return tables
            .reduce(extractColumns, [])
            .filter(couldBeSQLTypeColumn)
            .map(findSQLTypeReferencesDeeply);
    }

    function resolveTables (elegibleTypesForTables) {
        const accumulator = {
            referencedTables: [],
            tables: []
        };
        elegibleTypesForTables
            .reduce(toTables, accumulator);
        return accumulator.tables;
    }

    function createSQLTypesFromAST (ast, elegibleTypesForTables) {
        const toTypeIdentifierTuple = type => ({
            type,
            identifier: type.identifier
        });

        const accumulator = {
            typesUsed: elegibleTypesForTables.slice(),
            createdSQLTypes: []
        };

        ast
            .map(toTypeIdentifierTuple)
            .reduce(createSQLTypes, accumulator);

        return accumulator.createdSQLTypes;
    }

    function assignProperSQLTypeToType (createdSQLTypes, type) {
        type.referencedType = createdSQLTypes
            .find(({ identifier }) => identifier == type.referencedType.identifier);
        return type;
    }

    function resolveNestedTypesReferences (createdSQLTypes, sqlType) {
        const { members, referencedType } = sqlType;
        if (members) {
            for (member of members)
                resolveNestedTypesReferences(createdSQLTypes, member);
            return;
        }

        if (!referencedType)
            return;

        if (isSQLTypeReference(referencedType)) {
            assignProperSQLTypeToType(createdSQLTypes, sqlType);
            return;
        }

        if (isTypedCollection(referencedType))
            resolveNestedTypesReferences(createdSQLTypes, referencedType);
    }

    function accumulateRemovingRepeated (acc, record) {
        if (!acc.includes(record))
            acc.push(record);
        return acc;
    };

    function findSQLTypeReferencesDeeply (type) {
        const { referencedType } = type;

        if (isTypedCollection(referencedType))
            return findSQLTypeReferencesDeeply(referencedType);

        return type;
    }

    function couldBeSQLTypeColumn ({ referencedType }) {
        return couldBeSQLType(referencedType)
            || (isTypedCollection(referencedType)
                && couldBeSQLTypeColumn(referencedType));
    }

    function getUsedSQLTypesDeeply (sqlTypes) {
        return sqlTypes
            .reduce(findUsedTypesRecursively, [])
            .reduce(accumulateRemovingRepeated, []);

        function findUsedTypesRecursively (acc, type) {
            if (isSQLEnumeratedType(type)) {
                acc.push(type);
                return acc;
            }

            if (isSQLType(type)) {
                acc.push(type);
                return type.members
                    .map(extractProperty('referencedType'))
                    .reduce(findUsedTypesRecursively, acc);
            }
            
            if (isTypedCollection(type))
                return findUsedTypesRecursively(acc, type.referencedType);
            
            return acc;
        }
    }

    function couldBeSQLType (type) {
        return isChoice(type)
            || isSQLTypeReference(type)
            || isEnumerated(type)
            || isNamedBitString(type);

        function isNamedBitString (type) {
            return isBitString(type) &&
                type.size === undefined;
        }
    }

    function toTables (accumulator, type) {
        if (isSetOf(type.internalType) ||
            isSequenceOf(type.internalType)) {
            return reducer(buildColumnsForTypedCollection, ...arguments);
        }

        if (!type.internalType.list) {
            return toTables(accumulator, type.internalType.referenceType);
        }

        return reducer(buildColumns, ...arguments);

        function reducer (columnBuilder, accumulator, type) {
            const table = createTable(columnBuilder, type);
            return customTransformations(updateAccumulator(accumulator, table), type, table);
        }

        function updateAccumulator (accumulator, table) {
            const { referencedTables, tables } = accumulator;
            tables.push(table);
            referencedTables.push(...extractReferencedTables(table));
            return accumulator;
        }

        function extractReferencedTables ({ columns }) {
            return columns
                .map(extractProperty('referencedType'))
                .reduce(toTableReferences, []);
        }
    }

    function createTable (columnsBuilder, type) {
        return {
            type: 'Table',
            identifier: type.identifier,
            columns: columnsBuilder(type)
        };
    }

    function customTransformations (accumulator, type, table) {
        const { referencedTables } = accumulator,
        { columns } = table;

        if (hasToAddIdColumn(referencedTables, type, columns)) {
            columns.unshift(buildColumn({
                translatedType: { type: 'UUID' },
                identifier: 'id'
            }));
        }

        return accumulator;

        function hasToAddIdColumn (referencedTables, type, columns) {
            const isTypeAReferenceToATable = referencedTables.includes(type.identifier),
            hasTableReferenceColumn = columns.some(column => isTableReference(column.referencedType)),
            hasColumnWithTypedCollectionOfId = columns.some(column =>
                isTypedCollection(column.referencedType) &&
                isTableReference(column.referencedType.referencedType));

            return isTypeAReferenceToATable ||
                (!hasTableReferenceColumn && hasColumnWithTypedCollectionOfId);
        }
    }

    function toTableReferences (tableReferences, referencedType) {
        if (isTypedCollection(referencedType)) {
            return toTableReferences(tableReferences, referencedType.referencedType);
        }

        if (isTableReference(referencedType)) {
            tableReferences.push(...referencedType.tableIdentifiers);
        }

        return tableReferences;
    }

    function buildColumns (type) {
        return type.internalType.list
            .map(pipe(
                partialApply(translateInternalType, type.identifier),
                buildColumn
            ));
    }

    function buildColumnsForTypedCollection (type) {
        return [buildColumn({
            translatedType: translateType(type),
            identifier: type.internalType.referenceType.identifier
        })];
    }

    function translateInternalType (tableIdentifier, type) {
        const {
            referenceType,
            identifier
        } = type;

        const translatedType = translateType(referenceType,
            checkObjectIdentifier(tableIdentifier, referenceType, identifier));

        return {
            translatedType: translatedType,
            identifier: identifier
        };

        function checkObjectIdentifier (tableIdentifier, referenceType, identifier) {
            if (referenceType.type == "ObjectIdentifier") {
                return tableIdentifier + capitalize(identifier);
            }

            return identifier;
        }
    }

    function buildColumn ({ translatedType, identifier }) {
        return {
            type: 'Column',
            identifier: identifier,
            referencedType: translatedType
        };
    }

    function translateType (type, identifier) {
        switch (type.type) {
            case 'BitString':
                return translateBitString(type, identifier);
            case 'Boolean':
                return translateBoolean();
            case 'CompleteTypeDeclaration':
                if (type.identifier == 'Date')
                    return {
                        type: 'Date',
                        identifier: identifier
                    };
                if (type.identifier == 'Time')
                    return {
                        type: 'Time',
                        identifier: identifier
                    };
                return translateType(type.internalType, type.identifier);
            case 'Choice':
                return translateChoice(type, identifier);
            case 'Enumerated':
                return translateEnumerated(identifier);
            case 'HigherLevelSizedType':
                return translateType(type.referenceType, identifier);
            case 'Integer':
                return translateInteger(type);
            case 'InternalTypeDeclaration':
                return translateType(type.referenceType, type.identifier);
            case 'OctetString':
                return translateOctetString(type);
            case 'GraphicString':
            case 'IA5String':
            case 'PrintableString':
            case 'VisibleString':
            case 'UTF8String':
            case 'T61String':
                return translateString(type);
            case 'Set':
            case 'Sequence':
                return translateCollection(type, identifier);
            case 'SetOf':
            case 'SequenceOf':
                return translateTypedCollection(type, identifier);
            case 'ObjectIdentifier':
                return translateObjectIdentifier(type, identifier);
            case 'Null':
            default:
                return translateNull();
        }
    }

    function translateObjectIdentifier (type, identifier) {
        if (!type.list.length) {
            return translateString(type);
        }

        return translateEnumerated(identifier);
    }

    function translateBitString (type, identifier) {
        if (!type.list.length) {
            return {
                type: 'BitString',
                size: translateString(type).size
            };
        }

        return {
            type: 'BitString',
            identifier: identifier
        };
    }

    function translateBoolean () {
        return { type: 'Boolean' };
    }

    function translateTypedCollection (type, identifier) {
        return {
            type: 'TypedCollection',
            referencedType: translateType(type.referenceType, identifier)
        };
    }

    function translateOctetString (type) {
        const translatedString = translateString(type),
        octetSize = translatedString.size !== undefined ?
            2 * translatedString.size :
            undefined;
        
        return Object.assign(translatedString, { size: octetSize });
    }

    function translateString (type) {
        const { type: sizeType, size } = resolveSize(type);
        return {
            type: 'String',
            size: size,
            isVariable: sizeType == 'Variable'
        };
        
        function resolveSize (type) {
            if (type.maxSize !== undefined) {
                return {
                    type: 'Variable',
                    size: type.maxSize != 'MAX' && type.maxSize != 'n' ?
                        `${type.maxSize}` : undefined
                };
            } else if (type.minSize !== undefined) {
                return {
                    type: 'Fixed',
                    size: `${type.minSize}`
                };
            }
            return {
                type: 'Variable',
                size: undefined
            };
        }
    }

    function translateInteger (type) {
        /**
         * When the list is empty, it means it's a regular INTEGER with no boundaries
         * The correct would be using `Number.MAX_SAFE_INTEGER` to make any later compiling
         * phase to come to use it's biggest Integer type, however, in the context of a database
         * DDL, bigints are rare. Therefore, 4 bytes is often enough.
         */
        
        if (type.list.length == 0) {
            return {
                type: 'Integer',
                numberOfBytes: 4
            };
        }

        const larger = type.list.reduce(toLarger, undefined),
        numberOfBytes = calculateNumberOfBytes(larger);

        return {
            type: 'Integer',
            numberOfBytes: numberOfBytes
        };

        function toLarger (larger, { value }) {
            if (value === undefined) {
                return larger;
            }
            return larger > Math.abs(value) ? larger : Math.abs(value);
        }

        function calculateNumberOfBytes (value) {
            let counter = 0, remainder = value;
            while (remainder >= 2) {
                remainder = ~~(remainder / 2);
                counter++;
            }
            return Math.ceil((counter + 1) / 8);
        }
    }

    function translateCollection (type, identifier) {
        const relatedCompleteTypeDeclaration = findCompleteTypeDeclaration(type);
        if (isElegibleTypeForTable(relatedCompleteTypeDeclaration)) {
            return {
                type: 'TableReference',
                tableIdentifiers: [relatedCompleteTypeDeclaration.identifier]
            };
        }

        if (type.list.every(type => type.type == 'EmptyType')) {
            return {
                type: 'EmptyType',
                identifier: identifier
            };
        }
        
        if (type.list.every(isEligibleToBeSQLTyped)) {
            return {
                type: 'SQLTypeReference',
                identifier: identifier
            };
        }
        
        const errorMessage = `Type ${relatedCompleteTypeDeclaration.type}, identified as ${identifier}, can't be a PostgreSQL type and it's not elegible to be a table.`;
        logError(errorMessage);
        throw new Error(errorMessage);
    }

    function translateChoice (type, identifier) {
        const tableIdentifiers = type.list
            .map(findCompleteTypeDeclaration)
            .filter(type => !!type && isElegibleTypeForTable(type))
            .map(type => type.identifier);
        
        if (tableIdentifiers.length) {
            return {
                type: 'TableReference',
                tableIdentifiers: tableIdentifiers
            };
        }

        if (!type.list.some(isElegibleTypeForTable)) {
            return {
                type: 'Choice',
                identifier: identifier
            };
        }

        const errorMessage = `Type ${type.type}, identified as ${identifier}, can't be a PostgreSQL type and it's not elegible to be a table.`;
        logError(errorMessage);
        throw new Error(errorMessage);
    }

    function translateNull () {
        return { type: 'Null' };
    }

    function translateEnumerated (identifier) {
        return {
            type: 'Enumerated',
            identifier: identifier
        };
    }

    function createSQLTypes (accumulator, { type, identifier }) {
        const createdSQLType = createSQLType(
            accumulator,
            {
                type: type,
                identifier: identifier,
            });

        if (!isNull(createdSQLType)) {
            const { createdSQLTypes } = accumulator,
            /*
            `createSQLType` may not use the passed `identifier` as the actual
            create SQL Type identifier. So, `wereTypeAlreadyCreated` can't be
            checked before the type creation attempt.
            */
            wereTypeAlreadyCreated = createdSQLTypes
                .find(_type => 
                    type.type == createdSQLType.type && 
                    _type.identifier == createdSQLType.identifier);
            
            if (!wereTypeAlreadyCreated)
                createdSQLTypes.push(createdSQLType);
        }
        
        return accumulator;
    }

    function createSQLType (accumulator, { type, identifier }) {
        if (accumulator.typesUsed.includes(type)) {
            return translateNull();
        }

        accumulator.typesUsed.push(type);

        switch (type.type) {
            case 'BitString':
                return createBitStringType(
                    accumulator,
                    {
                        list: type.list,
                        identifier: capitalize(identifier)
                    });
            case 'CompleteTypeDeclaration':
                return createSQLType(
                    accumulator,
                    {
                        type: type.internalType,
                        identifier: capitalize(type.identifier)
                    });
            case 'Choice':
                return createChoiceType(
                    accumulator,
                    {
                        list: type.list,
                        identifier: capitalize(identifier)
                    });
            case 'Enumerated':
                return createEnumeratedType(
                    accumulator,
                    {
                        list: type.list,
                        identifier: capitalize(identifier)
                    });
            case 'InternalTypeDeclaration':
                return createSQLType(
                    accumulator,
                    {
                        type: type.referenceType,
                        identifier: capitalize(type.identifier)
                    });
            case 'Set':
            case 'Sequence':
                return createCollectionType(
                    accumulator,
                    {
                        list: type.list,
                        identifier: capitalize(identifier)
                    });
            case 'Date':
                return {
                    type: 'Date',
                    identifier: identifier,
                    members: members
                };
            case 'Time':
                return {
                    type: 'Time',
                    identifier: identifier,
                    members: members
                };
            case 'SQLType':
            default:
                return translateNull();
        }
    }

    function buildMember (accumulator, referencedTypeBuilder, type) {
        createSQLTypes(
            accumulator,
            {
                type: type,
                identifier: type.identifier
            });

        const sqlType = referencedTypeBuilder
            ? referencedTypeBuilder(type)
            : translateType(type, type.identifier),
        postgresType = sqlType && couldBeSQLType(sqlType)
            ? accumulator.createdSQLTypes
                .find(postgresType =>
                    postgresType.identifier.toLowerCase() == sqlType.identifier.toLowerCase())
            : undefined;

        return Object.assign(
            {
                type: 'Member',
                identifier: type.identifier
            },
            { referencedType: postgresType || sqlType }
        );
    }

    function createBitStringType (accumulator, { list, identifier }) {
        if (!list.length) {
            return translateNull();
        }

        const members = list
            .map(buildMember.bind(null, accumulator, translateBoolean));

        return {
            type: 'SQLType',
            identifier: identifier,
            members: members
        };
    }

    function createChoiceType (accumulator, { list }) {
        if (list.some(isElegibleTypeForTable)) {
            return translateNull();
        }

        return createCollectionType(...arguments);
    }

    function createEnumeratedType (accumulator, { list, identifier }) {
        const members = list
            .map(buildMember.bind(null, accumulator, () => undefined));

        return {
            type: 'SQLEnumeratedType',
            identifier: identifier,
            members: members
        };
    }

    function createCollectionType (accumulator, { list, identifier }) {
        if (list.every(type => type.type == 'EmptyType')) {
            return {
                type: 'EmptyType',
                identifier: identifier
            };
        }

        if (list.every(isEligibleToBeSQLTyped)) {
            const members = list
                .map(buildMember.bind(null, accumulator, null));

            return {
                type: 'SQLType',
                identifier: identifier,
                members: members
            };
        }

        return translateNull();        
    }

    function findCompleteTypeDeclaration (type) {
        if (type.type == 'CompleteTypeDeclaration') {
            return type;
        } else if (type.type == 'InternalTypeDeclaration') {
            return findCompleteTypeDeclaration(type.referenceType);
        }

        return ast.find(astType => astType.internalType == type);
    }

    function isEligibleToBeSQLTyped (type) {
        return !isElegibleTypeForTable(type) && isSQLTypableType(type);
    }

    function isSQLTypableType (type) {
        if (type.type == 'CompleteTypeDeclaration') {
            return isSQLTypableType(type.internalType);
        } else if (type.type == 'InternalTypeDeclaration' || type.type == 'HigherLevelSizedType') {
            return isSQLTypableType(type.referenceType);
        }

        return type.type == 'OctetString' ||
            type.type == 'Boolean' ||
            type.type == 'GraphicString' ||
            type.type == 'IA5String' ||
            type.type == 'PrintableString' ||
            type.type == 'VisibleString' ||
            type.type == 'UTF8String' ||
            type.type == 'T61String' ||
            type.type == 'BitString' ||
            type.type == 'Integer' ||
            type.type == 'Enumerated' ||
            type.type == 'Sequence' ||
            type.type == 'SequenceOf' ||
            type.type == 'Set' ||
            type.type == 'SetOf' ||
            type.type == 'Choice' ||
            type.type == 'Null';
    }

    function isElegibleTypeForTable (type) {
        if (type.type == 'CompleteTypeDeclaration') {
            return elegibleTypesForTables.includes(type);
        } else if (type.type == 'InternalTypeDeclaration' || type.type == 'HigherLevelSizedType') {
            return isElegibleTypeForTable(type.referenceType);
        }

        return false;
    }
}