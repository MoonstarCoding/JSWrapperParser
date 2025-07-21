import { IncomingMessage } from "http";
import {
  DEFAULT_WRAPPER_CONFIG,
  DEFAULT_FIELD_CONFIG,
  DEFAULT_CONFIG,
} from "./defaults";

export const _prepConfig = (c) => {
  const config = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...c };
  const preppedConfig = { parser: config.parser, wrappers: {} };
  const WRAPPERS = Object.keys(config.wrappers);
  WRAPPERS.forEach((wrapper) => {
    const preppedWrapper = JSON.parse(JSON.stringify(DEFAULT_WRAPPER_CONFIG));
    Object.keys(config.wrappers[wrapper].fields).forEach((field) => {
      preppedWrapper.fields[field] = {
        ...DEFAULT_FIELD_CONFIG,
        ...config.wrappers[wrapper].fields[field],
      };
    });
    preppedWrapper.import = {
      ...preppedWrapper.import,
      ...config.wrappers[wrapper].import,
    };
    preppedConfig.wrappers[wrapper] = preppedWrapper;
  });
  return preppedConfig;
};

export const _validateConfig = (config) => {
  try {
    Object.keys(config.wrappers).forEach((wrapper) => {
      if (config.wrappers[wrapper].import.module === null)
        throw "Every wrapper field must specify an import module!";
    });
  } catch (err) {
    throw { type: "InvalidConfigError", message: err };
  }
};

export const _parseImports = (module) => {
  return module.body
    .filter(
      (token) =>
        token.type === "ImportDeclaration" && token.specifiers.length > 0
    )
    .map((token) => {
      if (token.specifiers[0].type === "ImportDefaultSpecifier")
        return {
          module: token.source.value,
          default: token.specifiers[0].local.value,
          named: [],
        };
      return {
        module: token.source.value,
        default: null,
        named: token.specifiers.map((spec) => {
          return spec.imported === null
            ? { name: spec?.local?.value, as: spec?.local?.value }
            : { name: spec?.imported?.value, as: spec?.local?.value }; // Special import styles and things like node_modules end up throwing a silent error here without the ? operator
        }),
      };
    });
};

export const _parseExports = (module) => {
  return module.body
    .filter(
      (token) =>
        (token.type === "ExportDefaultExpression" &&
          token.expression.type === "CallExpression" &&
          token.expression.callee.type === "Identifier") ||
        (token.type === "ExportDeclaration" &&
          token.declaration.type === "VariableDeclaration" &&
          token.declaration.declarations[0].type === "VariableDeclarator" &&
          token.declaration.declarations[0].id.type === "Identifier" &&
          token.declaration.declarations[0].init?.type === "CallExpression")
    )
    .map((token) => {
      if (token.type == "ExportDefaultExpression")
        return {
          wrapper: token.expression.callee.value,
          name: null,
          default: true,
          args: token.expression.arguments,
        };
      else if (token.type === "ExportDeclaration")
        return {
          wrapper: token.declaration.declarations[0].init.callee.value,
          name: token.declaration.declarations[0].id.value,
          default: false,
          args: token.declaration.declarations[0].init.arguments,
        };
    });
};

const PROP_TYPES = {
  StringLiteral: "string",
  NumericLiteral: "number",
  BooleanLiteral: "boolean",
  ArrayExpression: "array",
};

const _propType = (v) => {
  if (Object.keys(PROP_TYPES).includes(v.type))
    return PROP_TYPES[v.type];
  return "unknown";
};

const _propValue = (v) => {
  if (_propType(v) === "string") return v.value;
  if (_propType(v) === "number") return v.value;
  if (_propType(v) === "boolean") return v.value;
  if (_propType(v) === "array") {
    const KNOWN_TYPES = v.elements.filter(elem => _propType(elem.expression) !== "unknown");
    return KNOWN_TYPES.map(elem => _propValue(elem.expression));
  }
  return null;
};

export const _match = (imports, exports, config, sourceFile) => {
  const IMPORT_DICT = {};

    for (const imp of imports) {
      if (imp.default !== null) {
        if (Object.keys(IMPORT_DICT).includes(imp.default))
          throw `Found multiple imports using the name '${imp.default}'`;
        IMPORT_DICT[imp.default] = {
          default: true,
          name: null,
          module: imp.module,
        };
      } else {
        for (const named of imp.named) {
          if (Object.keys(IMPORT_DICT).includes(named.as))
          throw `Found multiple imports using the name '${named.as}'`;
          IMPORT_DICT[named.as] = {
            default: false,
            name: named.name,
            module: imp.module,
          };
        }
      }
    }

    const PARSED = {};
    Object.keys(config.wrappers).forEach((key) => (PARSED[key] = []));

    for (const exp of exports) {
      if (Object.keys(IMPORT_DICT).includes(exp.wrapper)) {
        const imp = IMPORT_DICT[exp.wrapper];
        const MATCHING_WRAPPERS = Object.keys(config.wrappers)
          .map((wrapperKey) => {
            const wrapper = config.wrappers[wrapperKey];
            if (
              wrapper.import.module === imp.module &&
              ((wrapper.import.default && imp.default) ||
                (!wrapper.import.default && wrapperKey === imp.name))
            )
              return { name: wrapperKey, ...wrapper };
            return null;
          })
          .filter((x) => x !== null);
        if (MATCHING_WRAPPERS.length === 0) continue;
        const wrapper = MATCHING_WRAPPERS[0];
        if (
          exp.args.length > 0 &&
          exp.args[0].expression.type === "ObjectExpression"
        ) {
          const props = {};
          exp.args[0].expression.properties.forEach((prop) => {
            props[prop.key.value] = {
              type: _propType(prop.value),
              value: _propValue(prop.value),
            };
          });
          const data = {};
          if (
            Object.keys(wrapper.fields).every((fieldName) => {
              const field = wrapper.fields[fieldName];
              if (field.required && !Object.keys(props).includes(fieldName))
                throw `Missing required field '${fieldName}' in declaration of '${exp.wrapper}'!`;
              if (!Object.keys(props).includes(fieldName) && !field.required) {
                data[fieldName] = field.default;
                return true;
              }
              if (Object.keys(props).includes(fieldName)) {
                if (
                  field.type === "any" ||
                  field.type === props[fieldName].type
                ) {
                  data[fieldName] = props[fieldName].value;
                  return true;
                } else {
                  throw `Type mismatch on field '${fieldName}' in declaration of '${exp.wrapper}'! Type '${field.type}' was expected but type '${props[fieldName].type}' was given!`;
                }
              }
              return false;
            })
          ) {
            PARSED[exp.wrapper].push({
              name: exp.name,
              sourceFile: sourceFile,
              default: exp.default,
              fields: data,
            });
          }
        }
      }
    }

    return PARSED;
};
