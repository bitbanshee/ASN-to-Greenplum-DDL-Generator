const { logMessage, logError } = require('./misc/logger'),
      _              = require('lodash');

module.exports = postgreSQLToGPSSMappings; 

function postgreSQLToGPSSMappings (gpssMappingBasicConfiguration, outputSchema, postgreSQLAST, topicPrefix) {
    logMessage('Starting GPSS jobs configuration generation...');
    logMessage('Checking basic configuration...');
    injectRequiredNodesIfNecessary(gpssMappingBasicConfiguration);
    logMessage('Checked.');

    const { tables, sqlTypes: availableTypes } = postgreSQLAST;
    const configurations = tables
        .map(table => {
            const freshConfiguration = _.cloneDeep(gpssMappingBasicConfiguration);
            injectInputMapping(availableTypes, table.columns, table, freshConfiguration, topicPrefix);
            injectOutputMapping(availableTypes, outputSchema, table, freshConfiguration);
            return {
                tableName: table.identifier,
                mappingConfiguration: freshConfiguration
            };
        });

    logMessage('GPSS jobs configuration generation finished.');
    return configurations;
}

function injectRequiredNodesIfNecessary (gpssMappingBasicConfiguration) {
    if (typeof gpssMappingBasicConfiguration.KAFKA !== 'object') {
        logError('Node KAFKA not found in the basic configurations file. ' +
            'The structure will be created, but make sure that the final ' +
            'configuration file has the required fields.');
        
        gpssMappingBasicConfiguration.KAFKA = {
            INPUT: {},
            OUTPUT: {}
        };
    } else {
        const kafkaNode = gpssMappingBasicConfiguration.KAFKA;
        if (typeof kafkaNode.INPUT !== 'object') {
            logError('Node KAFKA:INPUT not found in the basic configurations file. ' +
                'The structure will be created, but make sure that the final ' +
                'configuration file has the required fields.');
            kafkaNode.INPUT = {};
        }
            
        
        if (typeof kafkaNode.OUTPUT !== 'object') {
            logError('Node KAFKA:OUTPUT not found in the basic configurations file. ' +
                'The structure will be created, but make sure that the final ' +
                'configuration file has the required fields.');
            kafkaNode.OUTPUT = {};
        }
    }
}

function injectInputMapping (availableTypes, columns, table, configuration, topicPrefix) {
    const inputNode = configuration.KAFKA.INPUT;
           
    inputNode.SOURCE.TOPIC = topicPrefix.concat(inputNode.SOURCE.TOPIC || table.identifier.toLowerCase());
    inputNode.VALUE = {
        FORMAT: 'csv',
        COLUMNS: columns
            .map(column => ({
                NAME: sanitizeSQLIdentifier(column.identifier),
                TYPE: resolveType(availableTypes, column.referencedType)
            }))
    };
    return configuration;
}

function injectOutputMapping (availableTypes, outputSchema, table, configuration) {
    const outputNode   = configuration.KAFKA.OUTPUT,
          actualSchema = outputNode.SCHEMA || outputSchema;
    
    // Despite Greenplum automatically converts any identifier without quotes to lower case, 
    // GPSS does not.
    outputNode.SCHEMA  = actualSchema.toLowerCase();
    outputNode.TABLE   = table.identifier.toLowerCase();
    outputNode.MAPPING = table.columns
        .map(column => {
            const sanitizedColumnIdentifier = sanitizeSQLIdentifier(column.identifier),
                  typeCast                  = resolveTypeCast(availableTypes, column.referencedType);
            return {
                NAME: sanitizedColumnIdentifier,
                EXPRESSION: typeCast === ''
                    ? sanitizedColumnIdentifier
                    : `(${sanitizedColumnIdentifier})::${actualSchema}.${typeCast}`
            }
        });
    return configuration;
}

function resolveType (availableTypes, type) {
    switch (type.type) {
        case 'Integer': return 'int'
        case 'Null':
        case 'Boolean': return 'bool'
        case 'TableReference':
        case 'UUID': return 'uuid'
        case 'Timestamp': return 'timestamp'
        case 'TypedCollection':
            const referencedTypeMapping = resolveType(availableTypes, type.referencedType);
            return `${referencedTypeMapping}[]`
        // EmptyType is a type that has no member, like a plain, empty JS object
        case 'EmptyType':
            return 'varchar[]'
        case 'SQLType':
        case 'BitString':
        case 'Choice':
        case 'Enumerated':
        case 'SQLEnumeratedType':
        case 'String':
        default: return 'varchar'
    }
}

function resolveTypeCast(availableTypes, type) {
    switch (type.type) {
        case 'TypedCollection':
            const innerTypeCast = resolveTypeCast(availableTypes, type.referencedType);
            if (innerTypeCast)
                return `${innerTypeCast}[]`
            return ''
        case 'Enumerated':
        case 'SQLEnumeratedType':
        case 'SQLType':
            return `${sanitizeSQLIdentifier(type.identifier)}`
        case 'BitString':
        case 'Choice':
            const actualType = availableTypes.find(availableType =>
                availableType.identifier == type.identifier);
            if (actualType)
                return resolveTypeCast(availableTypes, actualType);
            // should not get here
            return '';
        case 'Integer':
        case 'Null':
        case 'Boolean':
        case 'TableReference':
        case 'UUID':
        case 'Timestamp':
        case 'EmptyType':
        case 'String':
        default: return ''
    }
}

function sanitizeSQLIdentifier (identifier) {
    return identifier.replace(/\W/g, '_');
}