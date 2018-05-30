const buildProgram = require('./src/cli');

const program = buildProgram(process.argv);

const fs = require('fs'),
    { logMessage, logError } = require('./src/misc/logger');

logMessage(`Reading file ${program.asnDefinition}...`);
const asn = fs.readFileSync(program.asnDefinition, { encoding: 'utf8' });
logMessage(`Reading finished.`);

const customizedEntitiesConfigurationsFileName = program.customEntitiesDefinition;
let customizedEntitiesConfigurationsDefinition;
if (customizedEntitiesConfigurationsFileName) {
    try {
        logMessage(`Reading custom entities configurations definition file and parsing it into JSON...`);
        const definitionString = fs.readFileSync(customizedEntitiesConfigurationsFileName, { encoding: 'utf8' });
        logMessage(`Reading finished.`);
        if (definitionString != '')
            customizedEntitiesConfigurationsDefinition = JSON.parse(definitionString);
    } catch (error) {
        logError(`Error parsing ${customizedEntitiesConfigurationsFileName}. It's not a valid JSON file. Details: ${error}.`);
        process.exit(2);
    }
}

const [rootTypeName, postgreSQLAST] = generatePostgreSQLAST(asn, customizedEntitiesConfigurationsDefinition);

exportPostgreSQLDDL({
    rootTypeName,
    withClause: program.withClause,
    customPartitionClause: program.customPartitionClause,
    partitionFrom: program.partitionFrom,
    partitionTo: program.partitionTo
}, postgreSQLAST);

if (program.exportAst)
    exportPostgreSQLAST({ rootTypeName }, postgreSQLAST);

if (program.exportViews)
    exportViews({
        rootTypeName,
        viewFieldsAliasDefinitionFileName: program.viewFieldsAliasDefinition,
        arrayUnfoldRatio: program.arrayUnfoldRatio
    }, postgreSQLAST);

if (program.exportGpssMappings)
    exportGpssMappings({
        gpssMappingBasicConfigurationFileName: program.gpssBasicConfiguration,
        outputSchema: program.outputSchema,
        topicPrefix: program.topicPrefix
    }, postgreSQLAST);

function generatePostgreSQLAST(asn, customizedEntitiesConfigurationsDefinition) {
    const asnParser = require('./src/asn-to-ast-parser'),
        { asnASTToPostgreSQLAST } = require('./src/asn-ast-to-postgresql-ast'),
        customizePostgreSQLASTEntities = require('./src/postgresql-ast-entities-customizer');

    const [rootTypeName, asnAST] = asnParser(asn),
        originalPostgreSQLAST = asnASTToPostgreSQLAST(asnAST),
        customizedPostgreSQLAST = customizePostgreSQLASTEntities(customizedEntitiesConfigurationsDefinition, originalPostgreSQLAST);

    return [rootTypeName, customizedPostgreSQLAST];
}

function exportPostgreSQLAST(options, postgreSQLAST) {
    const { rootTypeName } = options;
    const postgreSQLASTToExportableAST = require('./src/postgresql-ast-to-exportable-ast');
    try {
        const exportablePostgreSQLAST = postgreSQLASTToExportableAST(postgreSQLAST),
            exportablePostgreSQLASTFileName = `${rootTypeName}_parser_structure.json`;

        try {
            logMessage(`Writing PostgreSQL AST in file ${exportablePostgreSQLASTFileName}...`);
            fs.writeFileSync(exportablePostgreSQLASTFileName, JSON.stringify(exportablePostgreSQLAST));
            logMessage(`Writing finished.`);
        } catch (error) {
            logError(`Error writing the exportable PostgreSQL AST. Skipping. Details: ${error.toString()}.`);
            return;
        }
    } catch (error) {
        logError(`Error generating the exportable PostgreSQL AST. Skipping. Details: ${error.toString()}.`);
    }
}

function exportPostgreSQLDDL(options, postgreSQLAST) {
    const {
        rootTypeName,
        withClause,
        customPartitionClause,
        partitionFrom,
        partitionTo
    } = options;

    const postgreSQLDDLGenerator = require('./src/postgresql-ddl-generator');
    try {
        const postgreSQLDDL = postgreSQLDDLGenerator(postgreSQLAST,
            {
                withClause,
                customPartitionClause,
                partitionFrom,
                partitionTo
            }),
            postgreSQLDDLFileName = `${rootTypeName}.sql`;

        try {
            logMessage(`Writing PostgreSQL DDL in file ${postgreSQLDDLFileName}...`);
            fs.writeFileSync(postgreSQLDDLFileName, postgreSQLDDL);
            logMessage(`Writing finished.`);
        } catch (error) {
            logError(`Error writing the PostgreSQL DDL. Skipping. Details: ${error.toString()}.`);
        }
    } catch (error) {
        logError(`Error generating the PostgreSQL DDL. Skipping. Details: ${error.toString()}.`);
    }
}

function exportViews(options, postgreSQLAST) {
    const { rootTypeName, arrayUnfoldRatio, viewFieldsAliasDefinitionFileName } = options;

    let viewFieldsAliasDefinition;
    if (viewFieldsAliasDefinitionFileName) {
        try {
            logMessage(`Reading view fields alias definition file and parsing it into JSON...`);
            const definitionString = fs.readFileSync(viewFieldsAliasDefinitionFileName, { encoding: 'utf8' });
            logMessage(`Reading finished.`);
            if (definitionString != '')
                viewFieldsAliasDefinition = JSON.parse(definitionString);
        } catch (error) {
            logError(`Error parsing ${viewFieldsAliasDefinitionFileName}. It's not a valid JSON file. Skipping. Details: ${error}.`);
        }
    }

    const { postgreSQLUnfoldedViewDDLGenerator } = require('./src/postgresql-unfolded-view-ddl-generator');
    try {
        const unfoldedPostgreSQLViewDDL = postgreSQLUnfoldedViewDDLGenerator(
            postgreSQLAST,
            { arrayUnfoldRatio, viewFieldsAliasDefinition }),
            postgreSQLUnfoldedViewFileName = `${rootTypeName}_view.sql`;

        try {
            logMessage(`Writing unfolded PostgreSQL VIEW DDL in file ${postgreSQLUnfoldedViewFileName}...`);
            fs.writeFileSync(postgreSQLUnfoldedViewFileName, unfoldedPostgreSQLViewDDL);
            logMessage(`Writing finished.`);
        } catch (error) {
            logError(`Error writing the PostgreSQL VIEW DDL. Skipping. Details: ${error.toString()}.`);
            return;
        }
    } catch (error) {
        logError(`Error generating the PostgreSQL VIEW DDL. Skipping. Details: ${error.toString()}.`);
    }
}

function exportGpssMappings(options, postgreSQLAST) {
    const { gpssMappingBasicConfigurationFileName, outputSchema, topicPrefix } = options;
    if (!gpssMappingBasicConfigurationFileName.endsWith('.yml')) {
        logError(`Please, provide an Yaml file as option ${BASIC_CONFIGURATION_GPSS_MAPPING_FILE_OPTION[0]}.`);
        logError(`Couldn't generate any GPSS mapping configuration file. Skipping.`);
        return;
    }

    const yaml = require('js-yaml');
    let gpssMappingBasicConfiguration;
    try {
        logMessage(`Reading file ${gpssMappingBasicConfigurationFileName}...`);
        gpssMappingBasicConfiguration = yaml.safeLoad(
            fs.readFileSync(gpssMappingBasicConfigurationFileName, { encoding: 'utf8' }),
            { json: true });
        logMessage(`Reading finished.`);
    } catch (error) {
        logError(`Error parsing the file ${gpssMappingBasicConfigurationFileName}. Skipping. Details: ${error.toString()}.`);
        return;
    }

    const folderName = 'gpss-mapping-configurations';
    try {
        logMessage(`Creating folder ${folderName} to put GPSS mapping configuration files...`);
        fs.mkdirSync(folderName);
        logMessage(`Folder created.`);
    } catch (error) {
        logError(`Can't create folder ${folderName}. Skipping. Details: ${error.toString()}.`);
        return;
    }

    const gpssMappingsGenerator = require('./src/postgres-ast-to-gpss-mappings')
    let gpssConfigurationFileName;
    try {
        const gpssMappings = gpssMappingsGenerator(gpssMappingBasicConfiguration, outputSchema, postgreSQLAST, topicPrefix);
        logMessage(`Writing GPSS mapping configuration files into ${folderName}...`);
        for (let { tableName, mappingConfiguration } of gpssMappings) {
            gpssConfigurationFileName = `${folderName}/${tableName}.yml`;
            fs.writeFileSync(
                gpssConfigurationFileName,
                yaml.safeDump(
                    mappingConfiguration,
                    {
                        indent: 4,
                        lineWidth: Number.MAX_SAFE_INTEGER
                    }));
        }
        logMessage(`Writing finished.`);
    } catch (error) {
        logError(`Error generating the GPSS mapping configuration file ${gpssConfigurationFileName}. Skipping. Details: ${error.toString()}.`)
    }
}