# ASN.1 type declaration to PostgreSQL DDL converter

A program to transform ASN.1 definition into an equivalent PostgreSQL DDL.

Convert ASN.1 type declarations to the closest PostgreSQL structure possible. It can generate:

* A JSON structure representing the PostgreSQL [AST](https://en.wikipedia.org/wiki/Abstract_syntax_tree) generated from the provided ASN.1 definition.
* A PostgreSQL script containing DDLs for every composite types and tables.
* A PostgreSQL script containing SQL View DDLs for every tables. Views and tables are different in the sense that each VIEW is the representation of a table with each composite type unfolded into new columns.
* A [GPSS](https://gpdb.docs.pivotal.io/5190/greenplum-stream/intro.html) (Greenplum Strem Server) job configuration file per PostgreSQL table.

It doesn't convert all ANS.1 types and syntax described in the [X.680](http://www.itu.int/rec/T-REC-X.680-201508-I/en). The parser is a regular parser, i.e., it's not the appropriate type of parser to parse a non regular language like ASN.1. However, it can convert some of the ASN.1 declarations provided by our clients so far.

It's restricted to the following ASN.1 types:

* BitString
* Boolean
* Choice
* Enumerated
* Integer
* OctetString
* GraphicString
* IA5String
* PrintableString
* VisibleString
* UTF8String
* T61String
* Null
* Set
* Sequence
* SetOf
* SequenceOf

## How it works

The converter chooses some types to be turned into SQL tables based on the type, its nesting level, its members, etc. Types that can't be tables are translated to primitive types or to PostgreSQL composite types. No index is created. No foreign keys is created. Keys can be created, which type is UUID, and are defined according to the ANS AST type relations.

Conversion goes through 4 steps:

1. The provided ASN declaration is read and parsed to an AST.
2. The ASN AST is transformed to become a PostgreSQL AST.
3. The PostgreSQL AST is exported as a JSON to be used by other programs.
4. The PostgreSQL AST is used to generate:
    * PostgreSQL DDLs.
    * PostgreSQL VIEW DDLs.
    * GPSS job configuration files.

## Usage

There is only one required argument, `-a, --asn-definition <definition>`, to which you must provide a path to a valid file containing the ASN.1 declaration.

Example:
```
node main.js -a ans_file.asn --partition-from2019-07-10 --partition-to 2024-07-10 -e custom_entities_configuration.json -u 1 --export-gpss-mappings --gpss-basic-configuration gpss_basic_configuration.yml --topic-prefix my_prefix
```

The current `--help` output is:
```
Usage: main [options]

A program to transform ASN.1 definition into an equivalent PostgreSQL DDL

Options:
  -a, --asn-definition <definition>              ASN.1 definition file path
  -w, --with-clause [clause]                     Custom WITH clause to be appended at the end of each table definition
  --partition-from [date]                        Initial partition date in format "YYYY-MM-DD" to be used in a daily PARTITION clause to be appended at the end of each table definition
  --partition-to [date]                          Final partition date in format "YYYY-MM-DD" to be used in a daily PARTITION clause to be appended at the end of each table definition
  -p, --custom-partition-clause [clause]         Custom PARTITION clause to be appended at the end of each table definition. If provided, --partition-from and --partition-to are ignored
  -e, --custom-entities-definition [definition]  Custom entities definitions to be included
  --export-ast                                   Export a JSON representation of a PostgreSQL AST containing type and tables descriptions
  -v, --export-views                             Export VIEWs representing each generated tables with no composite types, i.e., composite types are unfolded into new columns named according to their hierarchical type names. Ex.: externalTypeName.midTypeName.internalTypeName will turn into a column called "externalTypeName_midTypeName_internalTypeName"
  -u, --array-unfold-ratio [ratio]               Number of columns to which array entities will be unfolded to generate VIEWs. See --export-views (default: 1)
  --view-fields-alias-definition [ratio]         Alias for composite types names and parameters to be used in the generated VIEWs. See --export-views
  --export-gpss-mappings                         Export type mappings for GPSS (Greenplum Stream Server) job description files. It's generated a .yml configuration file per table, mapping the CSV representation of a record into a typed, Greenplum friendly, representation. See GPSS documentation for further details
  --gpss-basic-configuration [path]              Yaml file containing the basic GPSS mapping configuration. This program sets up the KAFKA:INPUT:VALUE and KAFKA:OUTPUT:MAPPING: in the basic configuration. All other data remains untouched. See GPSS documentation for further details about configuration file structure (default: "./gpss-basic-configuration.yml")
  --output-schema [schema]                       Schema used to make references to composite types in KAFKA:OUTPUT:MAPPING node. If KAFKA:OUTPUT:SCHEMA is set in --gpss-basic-configuration file, this option is ignored.
  --topic-prefix [prefix]                        Prefix for KAFKA:INPUT:SOURCE:TOPIC. Topics are considered to have the same name as their related tables. (default: "")
  -h, --help                                     output usage information
```

### Configuration Descriptors

#### VIEW Field Alias Descriptor

The generated VIEWs have their column names composed using the rules below:

1. in case of the original table column be a simple type, the original table column name is used.
2. in case of the original table column be a composite type, the name is composed by the name of the types of each level. For example, considering the type `IPAddress` described below, a column of that type would be unfolded into 4 column in the VIEW:
  - `ipaddress_ipbinaryaddress_ipbinv4address`
  - `ipaddress_ipbinaryaddress_ipbinv6address`
  - `ipaddress_iptextrepresentedaddress_iptextv4address`
  - `ipaddress_iptextrepresentedaddress_iptextv6address`

```sql
CREATE TYPE IPBinaryAddress AS (
  iPBinV4Address varchar,
  iPBinV6Address varchar
);

CREATE TYPE IPTextRepresentedAddress AS (
  iPTextV4Address varchar,
  iPTextV6Address varchar
);

CREATE TYPE IPAddress AS (
  iPBinaryAddress IPBinaryAddress,
  iPTextRepresentedAddress IPTextRepresentedAddress
);
```

Sometimes, a type can have many nested leves, increasing the length of the unfolded column names to the point of truncating them due to the [PostgreSQL indentifier length limit of 63 characters](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS).

To overcome that PostgreSQL limitation without the need of dealing with its source code, we designed a way to customize the unfolded column names. It consists in passing a descriptor file through the option `--view-fields-alias-definition`. The descriptor is a JSON configuration, an array of objects describing a **rule** used to match the column names and an **alias** to replace accordingly. An example of a descriptor declaration can be found below:

```json
[
  {
    "rule": "abnormal-Finish-Info[*].*",
    "alias": "abn"
  },
  {
    "rule": "cS-Location-Information[*].*",
    "alias": "csli"
  },
  {
    "rule": "es-Service-Information.*",
    "alias": "essi"
  },
  {
    "rule": "[*].accessCorrelationID..accessNetworkChargingIdentifier",
    "alias": "accenetchid"
  },
]
```

The grammar for the **rule** field is described in the [Alias Rule Guide](./AliasRuleGuide.md).

## Testing

Unit tests are done using [Jest](https://jestjs.io/). There is no integration test.

## Roadmap

- Provide/implement a [proper ASN.1 parser](https://sites.google.com/site/ramaswamyr/article/parsing-asn-1).
- Make the compiler recognize and convert all ANS.1 types and syntax described in the [X.680](http://www.itu.int/rec/T-REC-X.680-201508-I/en) recommended standard.

## Contributing

You can help sending a pull request! Feel free to sugest changes, enhancements or even provide/implement a proper ASN.1 parser :heart: