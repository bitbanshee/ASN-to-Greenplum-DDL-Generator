const {
    extractProperty,
    findBy,
    flattenedFromFunction,
    identity,
    isTableReference,
    isTypedCollection,
    partialApply,
    pipe,
    separate
} = require('./misc/util');

module.exports = customizeTables;

function customizeTables (customizedTableConfigurationsDefinition, db_ast) {
    if (!customizedTableConfigurationsDefinition) {
        return db_ast;
    }

    const {
        tables,
        sqlTypes
    } = db_ast,
    {
        add: {
            types: typesToBeAdded = [],
            columns: columnsToBeAdded = []
        } = {},
        eliminate: {
            tables: tablesToBeEliminated = []
        } = {},
        modify: {
            columns: columnsToBeModified = []
        } = {}
    } = customizedTableConfigurationsDefinition,
    addedTypes = typesToBeAdded
        .map(buildType(db_ast));

    sqlTypes.push(...addedTypes);
    columnsToBeAdded
        .reverse()
        .forEach(addColumn(db_ast));

    modifyColumn(db_ast,columnsToBeModified);      

    const findConfigurationOfTablesToBeEliminated = findBy('identifier')(extractProperty('identifier'))(tablesToBeEliminated),
    [eliminatedTables, continuedTables] = separate(findConfigurationOfTablesToBeEliminated, tables);

    /**
     * Tables are considered sorted by their reference tables, i.e., when a table A has references to a
     * table B, so A comes before B in the array.
     */
    eliminatedTables.forEach(
        apply_columns_drill_down_columns_from_eliminated_table(tables, findConfigurationOfTablesToBeEliminated));

    return Object.assign(db_ast, { tables: continuedTables });
}

function modifyColumn (db_ast, columnsToBeModified) {
    columnsToBeModified.forEach(({identifier, totype}) => 
    db_ast.tables
        .forEach(table =>
            table.columns
            .filter(column => column.identifier == identifier)
            .forEach(column => column.referencedType = buildReferencedType(totype, column.referencedType))
        )
    )
}

function buildReferencedType(type, referencedType){
    switch(type){
        case "int2":
            return {type: "Integer", numberOfBytes:2, size: 2, isVariable: false};
        case "int":
            return {type: "Integer", size: 2, isVariable: false};
        default:
            return referencedType;
    }
}

function addColumn (db_ast) {
    return columnDescriptor => {
        const { tables: passedTablesNames } = columnDescriptor,
        tablesToAddColumn = resolveTablesToAddColumn(db_ast, passedTablesNames),
        columnToBeAdded = updateColumnTypeIfNeeded(db_ast.sqlTypes, columnDescriptor),
        addColumnToTable = addSpecificColumnToTable(columnToBeAdded);

        tablesToAddColumn
            .forEach(addColumnToTable);
    };

    function resolveTablesToAddColumn (db_ast, passedTablesNames) {
        const { tables: originalTables } = db_ast;

        if (passedTablesNames == 'all') {
            return originalTables;
        }
        
        return passedTablesNames
            .map(APIHookTransformation(db_ast))
            .reduce(partialApply(flattenedFromFunction, identity), [])
            .filter(identity)
            .map(tableName => originalTables.find(table => table.identifier == tableName));
    }

    function addSpecificColumnToTable (columnToBeAdded) {
        return table =>
            table.columns.unshift(buildColumn({
                translatedType: columnToBeAdded.type,
                identifier: columnToBeAdded.identifier
            }));
    }

    // Same function available in asnASTToDBASTCompiler module (REFACTOR)
    function buildColumn ({ translatedType, identifier }) {
        return {
            type: 'Column',
            identifier: identifier,
            referencedType: translatedType
        };
    }

    function updateColumnTypeIfNeeded (sqlTypes, columnDescriptor) {
        const { type: columnType } = columnDescriptor;

        if (columnType.isReferencedType) {
            // Creating new objects to maintain some immutability and avoid wrong reference updates
            return Object.assign({}, columnDescriptor, {
                type: Object.assign({}, columnType, {
                    referencedType: sqlTypes.find(type => type.identifier == columnType.identifier)
                })
            });
        }

        return columnDescriptor;
    }
 }

function buildType (db_ast) {
    return typeDescriptor => {
        if (Array.isArray(typeDescriptor.members)) {
            return Object.assign({}, typeDescriptor, {
                members: typeDescriptor.members
                    .map(APIHookTransformation(db_ast))
                    .reduce(partialApply(flattenedFromFunction, identity), [])
                    .filter(identity)
                    .map(buildMember)
            });
        }

        return typeDescriptor;
    };

    function buildMember (memberString) {
        return {
            type: 'Member',
            identifier: memberString
        };
    }
}

function APIHookTransformation (db_ast) {
    return val => {
        if (typeof val == 'string') {
            return val;
        }
    
        if (val.type == 'TableReferenceNames') {
            return buildTableReferenceNames(db_ast.tables, val);
        }
    
        return null;
    };
}

function buildTableReferenceNames (tables, tableReferenceNameType) {
    const {
        table: tableName,
        column: columnName
    } = tableReferenceNameType,
    table = tables.find(table => table.identifier == tableName);
    if (!table) {
        return null;
    }
    const column = table.columns.find(column => column.identifier == columnName);
    if (!column) {
        return null;
    }
    return extractReferences(column);
}

function isTableReferenceColumn (column) {
    return isTableReference(column.referencedType);
}

function isReferenceCollectionColumn (column) {
    return isTypedCollection(column.referencedType) && isTableReference(column.referencedType.referencedType);
}

function extractReferences (column) {
    if (isTableReference(column.referencedType)) {
        return column.referencedType.tableIdentifiers;
    }

    if (column.referencedType.referencedType &&
        isTableReference(column.referencedType.referencedType)) {
        return column.referencedType.referencedType.tableIdentifiers;
    }

    return [];
}

function from_original_column_to_references_and_drill_down_column_pair (columnReplacements, identifierSufix, referencedType) {
    return column => {
        const replacement = columnReplacements
            .find(reference => reference.from == column.identifier);

        return [[
            extractReferences(column),
            {
                type: 'Column',
                referencedType: referencedType || { type: 'UUID' },
                identifier: resolveIdentifier(column, replacement),
                isAditionalIDColumn: true
            }
        ]];
    };

    function resolveIdentifier (column, replacement) {
        return (!replacement ?
            column.identifier :
            replacement.to) +
            (identifierSufix || '')
    }
}

function apply_columns_drill_down_columns_from_eliminated_table (tables, findConfigurationOfTablesToBeEliminated) {
    return eliminatedTable => {
        const { columns } = eliminatedTable,
        referenceColumns = columns.filter(isTableReferenceColumn),
        referenceCollectionColumns = columns.filter(isReferenceCollectionColumn);

        if (!referenceColumns.length && !referenceCollectionColumns.length) {
            return;
        }

        const { columnReplacements } = findConfigurationOfTablesToBeEliminated(eliminatedTable),
        pairMapperBuilder = partialApply(from_original_column_to_references_and_drill_down_column_pair, columnReplacements),
        toIdPairs = partialApply(flattenedFromFunction, pairMapperBuilder('_id')),
        toSequentialPairs = partialApply(flattenedFromFunction, pairMapperBuilder('_sequential',
            { type: 'Integer' })),
        referenceCollectionPairs = [].concat(
            referenceCollectionColumns.reduce(toSequentialPairs, []),
            referenceCollectionColumns.reduce(toIdPairs, [])),
        allReferencesFromCollection = referenceCollectionColumns
            .reduce(partialApply(flattenedFromFunction, extractReferences), []),
        aditionalIdColumns = columns.filter(extractProperty('isAditionalIDColumn')),
        allReferencesFromReference = referenceColumns
            .reduce(partialApply(flattenedFromFunction, extractReferences), []),
        globalReferences = [... new Set(allReferencesFromReference.concat(allReferencesFromCollection))],
        aditionalIdPairs = aditionalIdColumns
            .map(aditionalIdColumn => [globalReferences, aditionalIdColumn])
            .reverse();

        [].concat(
            resolvePairs(),
            referenceCollectionPairs)
            .forEach(updateTables(tables));

        function resolvePairs () {
            if (aditionalIdPairs.length) {
                return aditionalIdPairs;
            }
    
            return referenceColumns
                .reduce(toIdPairs, [])
                .map(pair => (pair[0] = [...new Set(pair[0].concat(allReferencesFromCollection))], pair));
        }
    };
};

function updateTables (tables) {
    return ([references, drillDownColumn]) => tables
        .filter(table => references.includes(table.identifier))
        .map(pipe(extractProperty('columns'), deleteIdColumn))
        .forEach(insertDrillDownColumn(drillDownColumn));
}

function deleteIdColumn (columns) {
    const idIndex = columns.findIndex(column => column.identifier == 'id');
    if (idIndex != -1) {
        columns.splice(idIndex, 1);
    }
    return columns;
}

function insertDrillDownColumn (drillDownColumn) {
    return columns => columns.unshift(drillDownColumn);
}