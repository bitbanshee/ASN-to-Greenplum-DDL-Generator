const { logError, logMessage } = require('./misc/logger'),
{
    extractProperty,
    flattenedFromFunction,
    isConsideredTableReferenceType,
    partialApply,
    pipe
} = require('./misc/util'),
MAX_DISTRIBUTION_COLUMNS = 5;

module.exports = db_ast_to_db_ddl;

function db_ast_to_db_ddl (
    ast,
    {
        withClause: customWithClause = '',
        customPartitionClause = '',
        partitionFrom = undefined,
        partitionTo = undefined
    } = {}
) {
    logMessage(`Starting PostgreSQL DDL generation...`);

    const toUnderlineRegexp = /\W/g,
    { tables, sqlTypes } = ast;

    logMessage(`Generating SQL Types DDL...`);
    const sqlTypesDDLs = sqlTypes.map(translateSQLTypeToDeclaration);
    logMessage(`${sqlTypesDDLs.length} types were defined.`);

    logMessage(`Counting the most common columns to infer the columns by which tables will be distributed...`);
    const mostCommonColumns = extractMostCommonColumns(tables);
    logMessage(`Distribution will be made by a column elected using the one of the following requirements:` +
        `\n\t1. a column of 'uuid' type.` +
        `\n\t2. the most common column among all tables, since it is of type 'timestamp'.` +
        `\n\t3. the most common column among all tables, since it is of type 'varchar'.` +
        `\nIf none of the requirements are met, the distribution will be made randomly.`);

    logMessage(`Generating Tables descriptors...`);
    const tablesDDLDescriptors = tables.map(partialApply(buildTableDDLDescriptor, mostCommonColumns));
    logMessage(`Tables descriptors generated.`);
    
    const tablesDDLDescriptorsWithoutDistributionColumn = tablesDDLDescriptors.filter(table => table.distributedBy.length == 0);
    logMessage(`${tablesDDLDescriptors.length - tablesDDLDescriptorsWithoutDistributionColumn.length} of ${tablesDDLDescriptors.length} tables have distribution columns.`);

    if (tablesDDLDescriptorsWithoutDistributionColumn.length) {
        logMessage(
            `The following tables have to be distributed manually:` +
            `\n\t- ${tablesDDLDescriptorsWithoutDistributionColumn.map(table => table.identifier).join('\n\t- ')}`
        );
    }

    logMessage(`Generating Tables DDL...`);
    const partitionClause = resolveClauseForDDL(buildPartitionClause());
    const withClause = resolveClauseForDDL(customWithClause);
    const tablesDDLS = tablesDDLDescriptors.map(createTableDDL);
    logMessage(`${tablesDDLS.length} tables were defined.`);

    logMessage(`PostgreSQL DDL generation finished.`);
    return sqlTypesDDLs.concat(tablesDDLS).join('\n');

    function translateSQLTypeToDeclaration (sqlType) {
        switch (sqlType.type) {
            case 'SQLEnumeratedType':
                return buildSQLEnumeratedTypeDeclaration(sqlType);
            case 'SQLType':
                return buildSQLTypeDeclaration(sqlType);
            default:
                const types = ['SQLEnumeratedType', 'SQLType'];
                throw new Error(`SQL AST Type not recognized. Provided: ${sqlType.type}. Expected: ${types.join(' or ')}.`);
        }
    }

    function buildSQLEnumeratedTypeDeclaration ({ identifier, members }) {
        return `CREATE TYPE ${identifier.replace(toUnderlineRegexp, '_')} AS ENUM ('${members.map(member => member.identifier).join("', '")}');`
    }

    function buildSQLTypeDeclaration ({ identifier, members }) {
        const membersDeclarations = members
            .map(buildSQLTypeMemberDeclaration);
        
        return `CREATE TYPE ${identifier.replace(toUnderlineRegexp, '_')} AS (\n\t${membersDeclarations.join(',\n\t')}\n);`

        function buildSQLTypeMemberDeclaration (member) {
            return `${member.identifier.replace(toUnderlineRegexp, '_')} ${translateTypeToDeclaration(member.referencedType)}`;
        }
    }

    function buildTableDDLDescriptor (mostCommonColumns, table) {
        const columns = table.columns.map(buildColumnDDLDescriptor);
        return {
            identifier: table.identifier,
            columns: columns,
            distributedBy: resolveDistributionColumns(mostCommonColumns, columns)
                .slice(0, MAX_DISTRIBUTION_COLUMNS)
        };

        function buildColumnDDLDescriptor (column) {
            return {
                type: column.referencedType,
                identifier: column.identifier,
                isOptional: column.isOptional,
                defaultValue: column.defaultValue
            };
        }

        function resolveDistributionColumns (mostCommonColumnsHash, columns) {
            const topColumnFrequency = mostCommonColumnsHash[0][1];
            const topCommonColumns = mostCommonColumnsHash
                .filter(([, frequency]) => frequency == topColumnFrequency)
                .map(extractProperty(0));
            const referenceTableColumns = columns
                .filter(pipe(
                    extractProperty('type'),
                    isConsideredTableReferenceType));
            const extractTopColumns = partialApply(filterDBASTColumnsByDescriptors, topCommonColumns);

            return [
                ...extractTopColumns(columns.filter(isUUIDColumn)),
                ...referenceTableColumns,
                ...extractTopColumns(columns.filter(isTimestampColumn)),
                ...extractTopColumns(columns.filter(isStringColumn))
            ];

            function isUUIDColumn ({ type }) {
                return type.type == 'UUID';
            }

            function isTimestampColumn ({ type }) {
                return type.type == 'Timestamp';
            }

            function isStringColumn ({ type }) {
                return type.type == 'String';
            }

            function isASTColumnEquivalentToColumnDDLDescriptor (dbASTColumnObject, columnDDLDescriptor) {
                return dbASTColumnObject.identifier == columnDDLDescriptor.identifier &&
                    dbASTColumnObject.referencedType.type == columnDDLDescriptor.type.type;
            }

            function filterDBASTColumnsByDescriptors (dbASTColumns, filteredColumnDescriptors) {
                return dbASTColumns
                    .filter(dbASTColumnObject =>
                        filteredColumnDescriptors.find(columnDDLDescriptor =>
                            isASTColumnEquivalentToColumnDDLDescriptor(dbASTColumnObject, columnDDLDescriptor)));
            }
        }
    }

    function extractMostCommonColumns (tables) {
        return [...tables
            .reduce(partialApply(flattenedFromFunction, extractProperty('columns')), [])
            .reduce((columnCountTuples, column) => {
                const tupleForCurrentColumn = columnCountTuples.find(pipe(
                    extractProperty(0),
                    partialApply(isColumnEquals, column)));
                if (tupleForCurrentColumn) {
                    tupleForCurrentColumn[1]++;
                } else {
                    columnCountTuples.push([column, 1]);
                }
                return columnCountTuples;
            }, [])]
                .filter(([, v]) => v > 1)
                .sort(([, v1], [, v2]) => v2 - v1);
    }

    function isColumnEquals (column1, column2) {
        return column1.identifier == column2.identifier &&
            column1.type.type == column2.type.type;
    }

    function createTableDDL ({ identifier, columns, distributedBy }) {
        const columnsDDLs = columns.map(createColumnDDL),
        distributionClause = distributedBy.length > 0
            ? `DISTRIBUTED BY (${extractIdentifiers(distributedBy)})`
            : `DISTRIBUTED RANDOMLY`;

        return `CREATE TABLE ${sanitizeIdentifier(identifier)} ` + 
            `(\n\t${columnsDDLs.join(',\n\t')}\n)` +
            `${withClause}` +
            `${resolveClauseForDDL(distributionClause)}` +
            `${partitionClause};`;

        function extractIdentifiers (distributedBy) {
            return distributedBy
                .map(pipe(
                    extractProperty('identifier'),
                    sanitizeIdentifier))
                .join(', ');
        }

        function sanitizeIdentifier (identifier) {
            return identifier.replace(toUnderlineRegexp, '_');
        }
    }

    function buildPartitionClause () {
        if (customPartitionClause)
            return customPartitionClause;

        try {
            const finalTime   = new Date(partitionTo).getTime(),
                  currentDate = new Date(partitionFrom),
                  dayMillis   = 1000 * 60 * 60 * 24,
                  partitions  = [];

            while (currentDate.getTime() < finalTime) {
                partitions.push(buildPartitionEntryClause(currentDate, true));
                currentDate.setTime(currentDate.getTime() + dayMillis);
            }

            // Rip the last partition and add an 'END' statement to it
            partitions.push(`${partitions.pop()} ${buildPartitionEntryClause(currentDate, false)}`);

            partitions.push('DEFAULT PARTITION unpartitioned');

            return `PARTITION BY RANGE (dateday)\n( ${partitions.join(' ,\n   ')} )`;
        } catch (error) {
            logError("Format of --partition-from or --partition-to not recognized. No partition will be done.");
            return '';
        }
    }

    function buildPartitionEntryClause (date, isStart = true) {
        if (isStart)
            return `PARTITION "${getFormatedDateForPartitionName(date)}" START (date '${getFormatedDateForSQL(date, '-')}') INCLUSIVE`;
        return `END (date '${getFormatedDateForSQL(date, '-')}') EXCLUSIVE`;
    }

    function getFormatedDateForPartitionName (date) {
        return getFormatedDateForSQL(date, '');
    }

    function getFormatedDateForSQL (date, separator) {
        return `${date.getUTCFullYear()}${separator}${padStart2With0(date.getUTCMonth() + 1)}${separator}${padStart2With0(date.getUTCDate())}`;
    }

    function padStart2With0 (str) {
        return str.toString().padStart(2, '0');
    }

    function resolveClauseForDDL (clause = '') {
        return clause.length ? `\n${clause}` : '';
    }

    function createColumnDDL (column) {
        return createBasicColumnDDL(column) + resolveObligatoriness(column);
    }

    function createBasicColumnDDL ({ identifier, type }) {
        return `${identifier.replace(toUnderlineRegexp, '_')} ${translateTypeToDeclaration(type)}`;
    }

    function resolveObligatoriness ({ isOptional, defaultValue }) {
        if (isOptional === false) {
            return ' NOT NULL';
        } else if (defaultValue) {
            return ` DEFAULT ${defaultValue}`;
        }
        return '';
    }

    function translateTypeToDeclaration (type) {
        switch (type.type) {
            case 'BitString':
                return buildBitStringDeclaration(type);
            case 'Boolean':
            case 'Null':
                return buildBooleanDeclaration(type);
            case 'Choice':
            case 'Enumerated':
            case 'SQLEnumeratedType':
            case 'SQLType':
            case 'SQLTypeReference':
                return buildReferenceTypeDeclaration(type);
            case 'EmptyType':
                return `${buildStringDeclaration()}[]`;
            case 'Integer':
                return buildIntegerTypeDeclaration(type);
            case 'String':
                return buildStringSizeDeclaration(type);
            case 'TableReference':
            case 'UUID':
                return buildUUIDDeclaration();
            case 'TypedCollection':
                return buildTypedCollectionDeclaration(type);
            case 'Timestamp':
                return buildTimestampDeclaration();
            case 'Date':
                return buildDateDeclaration();
            case 'Time':
                return buildTimeDeclaration();
            default:
                const types = [
                    'BitString',
                    'Boolean',
                    'Choice',
                    'Enumerated',
                    'Integer',
                    'SQLEnumeratedType',
                    'SQLType',
                    'SQLTypeReference',
                    'String',
                    'TableReference',
                    'Timestamp',
                    'TypedCollection',
                    'UUID'
                ];
                throw new Error(`SQL AST Type not recognized. Provided: ${type.type}. Expected: ${types.join(' or ')}.`);
        }
    }

    function buildBitStringDeclaration ({ identifier, size }) {
        if (size === undefined) {
            return identifier;
        }
        return `varbit` + (size ? `(${size})` : '');
    }

    function buildBooleanDeclaration () {
        return 'bool';
    }

    function buildIntegerTypeDeclaration ({ numberOfBytes }) {
        if (numberOfBytes === undefined) {
            return 'int';
        }

        if (numberOfBytes <= 2) {
            return 'smallint';
        }

        if (numberOfBytes <= 4) {
            return 'int';
        }

        return 'bigint';
    }

    function buildReferenceTypeDeclaration ({ identifier }) {
        return identifier.replace(toUnderlineRegexp, '_');
    }

    function buildStringSizeDeclaration (/*{ size, isVariable }*/) {
        return buildStringDeclaration();
        /**
         * There's no performance advantage to use the `char` type or any
         * size limitation in PostgreSQL. See:
         * https://www.postgresql.org/docs/9.1/static/datatype-character.html
         */
        /*return (isVariable ? 'var' : '') + 'char' + (size ? `(${size})` : '');*/
    }

    function buildStringDeclaration () {
        return 'varchar';
    }

    function buildUUIDDeclaration () {
        return 'uuid';
    }

    function buildTypedCollectionDeclaration ({ referencedType }) {
        return translateTypeToDeclaration(referencedType) + '[]';
    }

    function buildTimestampDeclaration () {
        return 'timestamp';
    }

    function buildTimeDeclaration () {
        return 'time';
    }

    function buildDateDeclaration () {
        return 'date';
    }
}