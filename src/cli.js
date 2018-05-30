const { logError } = require('./misc/logger'),
      program      = require('commander'),
      _            = require('lodash');

module.exports = _.once(buildProgram);

const PROGRAM_DESCRIPTION = 'A program to transform ASN.1 definition into an equivalent PostgreSQL DDL',
    ASN_DEFINITION_OPTION = [
        '-a, --asn-definition <definition>',
        'ASN.1 definition file path'
    ],
    CUSTOM_WITH_CLAUSE_OPTION = [
        '-w, --with-clause [clause]',
        'Custom WITH clause to be appended at the end of each table definition'
    ],
    INITIAL_PARTITION_DATE_OPTION = [
        '--partition-from [date]',
        'Initial partition date in format "YYYY-MM-DD" to be used in a daily PARTITION clause to be appended at the end of each table definition'
    ],
    FINAL_PARTITION_DATE_OPTION = [
        '--partition-to [date]',
        'Final partition date in format "YYYY-MM-DD" to be used in a daily PARTITION clause to be appended at the end of each table definition'
    ],
    CUSTOM_PARTITION_CLAUSE_OPTION = [
        '-p, --custom-partition-clause [clause]',
        'Custom PARTITION clause to be appended at the end of each table definition. If provided, --partition-from and --partition-to are ignored'
    ],
    CUSTOM_ENTITIES_DEFINITION_OPTION = [
        '-e, --custom-entities-definition [definition]',
        'Custom entities definitions to be included'
    ],
    EXPORT_AST_OPTION = [
        '--export-ast',
        'Export a JSON representation of a PostgreSQL AST containing type and tables descriptions'
    ],
    EXPORT_VIEW_OPTION = [
        '-v, --export-views'
        , 'Export VIEWs representing each generated tables with no composite types, i.e., composite types are ' +
        'unfolded into new columns named according to their hierarchical type names. ' +
        'Ex.: externalTypeName.midTypeName.internalTypeName will turn into a column called "externalTypeName_midTypeName_internalTypeName"'
    ],
    ARRAY_UNFOLD_RATIO_OPTION = [
        '-u, --array-unfold-ratio [ratio]',
        'Number of columns to which array entities will be unfolded to generate VIEWs. See --export-views',
        1
    ],
    VIEW_FIELS_ALIAS_DEFINITION_OPTION = [
        '--view-fields-alias-definition [ratio]',
        'Alias for composite types names and parameters to be used in the generated VIEWs. See --export-views'
    ],
    EXPORT_GPSS_MAPPINGS_OPTION = [
        '--export-gpss-mappings'
        , 'Export type mappings for GPSS (Greenplum Stream Server) job description files. It\'s generated a ' +
        '.yml configuration file per table, mapping the CSV representation of a record into a typed, ' +
        'Greenplum friendly, representation. See GPSS documentation for further details'
        , false
    ],
    BASIC_CONFIGURATION_GPSS_MAPPING_FILE_OPTION = [
        '--gpss-basic-configuration [path]'
        , 'Yaml file containing the basic GPSS mapping configuration. This program sets up the KAFKA:INPUT:VALUE ' +
        'and KAFKA:OUTPUT:MAPPING: in the basic configuration. All other data remains untouched. See GPSS ' + 
        'documentation for further details about configuration file structure'
        , './gpss-basic-configuration.yml'
    ],
    OUTPUT_SCHEMA_GPSS_MAPPING_OPTION = [
        '--output-schema [schema]'
        , 'Schema used to make references to composite types in KAFKA:OUTPUT:MAPPING node. If KAFKA:OUTPUT:SCHEMA is ' +
        'set in --gpss-basic-configuration file, this option is ignored.'
    ],
    SOURCE_TOPIC_PREFIX_GPSS_OPTION = [
        '--topic-prefix [prefix]'
        , 'Prefix for KAFKA:INPUT:SOURCE:TOPIC. Topics are considered to have the same name as their related tables.'
        , ''
    ];

function buildProgram (args) {
    program
        .description(PROGRAM_DESCRIPTION)
        .option(...ASN_DEFINITION_OPTION)
        .option(...CUSTOM_WITH_CLAUSE_OPTION)
        .option(...INITIAL_PARTITION_DATE_OPTION)
        .option(...FINAL_PARTITION_DATE_OPTION)
        .option(...CUSTOM_PARTITION_CLAUSE_OPTION)
        .option(...CUSTOM_ENTITIES_DEFINITION_OPTION)
        .option(...EXPORT_AST_OPTION)
        .option(...EXPORT_VIEW_OPTION)
        .option(...ARRAY_UNFOLD_RATIO_OPTION)
        .option(...VIEW_FIELS_ALIAS_DEFINITION_OPTION)
        .option(...EXPORT_GPSS_MAPPINGS_OPTION)
        .option(...BASIC_CONFIGURATION_GPSS_MAPPING_FILE_OPTION)
        .option(...OUTPUT_SCHEMA_GPSS_MAPPING_OPTION)
        .option(...SOURCE_TOPIC_PREFIX_GPSS_OPTION)
        .parse(args);
    
    validateInputOptions(program);
    return program;
}

function validateInputOptions (program) {
    if (!program.asnDefinition
        || !program.asnDefinition.endsWith('.asn')) {
        logError(`Please, provide an ASN file as option ${ASN_DEFINITION_OPTION[0]}.`);
        program.outputHelp();
        process.exit();
    }
}