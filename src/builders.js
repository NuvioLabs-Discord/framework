export const CommandType = Object.freeze({ ChatInput: 1, User: 2, Message: 3 });
export const OptionType = Object.freeze({ Subcommand: 1, SubcommandGroup: 2, String: 3, Integer: 4, Boolean: 5, User: 6, Channel: 7, Role: 8, Mentionable: 9, Number: 10, Attachment: 11 });
export const ComponentType = Object.freeze({ ActionRow: 1, Button: 2, StringSelect: 3, TextInput: 4, UserSelect: 5, RoleSelect: 6, MentionableSelect: 7, ChannelSelect: 8 });

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function copyObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return { ...value };
}

export class OptionBuilder {
  constructor(type, name, description) {
    this.data = { type, name: requiredString(name, 'name'), description: requiredString(description, 'description'), required: false };
  }
  required(value = true) { this.data.required = Boolean(value); return this; }
  choices(choices) {
    if (!Array.isArray(choices)) throw new TypeError('choices must be an array');
    this.data.choices = choices.map(choice => typeof choice === 'object' ? copyObject(choice, 'choice') : { name: String(choice), value: choice });
    return this;
  }
  channelTypes(types) { this.data.channel_types = [...types]; return this; }
  min(value) { this.data.min_value = value; return this; }
  max(value) { this.data.max_value = value; return this; }
  length(min, max) { if (min !== undefined) this.data.min_length = min; if (max !== undefined) this.data.max_length = max; return this; }
  autocomplete(value = true) { this.data.autocomplete = Boolean(value); return this; }
  localize(name, value) { this.data[`${name}_localizations`] = { ...(this.data[`${name}_localizations`] || {}), ...copyObject(value, `${name} localizations`) }; return this; }
  toJSON() { return { ...this.data }; }
}

export class CommandBuilder {
  constructor(name, description, type = CommandType.ChatInput) {
    this.data = { name: requiredString(name, 'name'), description: requiredString(description, 'description'), type };
    this.options = [];
  }
  option(value) { this.options.push(value.toJSON ? value.toJSON() : copyObject(value, 'option')); return this; }
  string(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.String, name, description); configure(value); return this.option(value); }
  integer(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.Integer, name, description); configure(value); return this.option(value); }
  boolean(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.Boolean, name, description); configure(value); return this.option(value); }
  user(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.User, name, description); configure(value); return this.option(value); }
  channel(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.Channel, name, description); configure(value); return this.option(value); }
  role(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.Role, name, description); configure(value); return this.option(value); }
  mentionable(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.Mentionable, name, description); configure(value); return this.option(value); }
  number(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.Number, name, description); configure(value); return this.option(value); }
  attachment(name, description, configure = () => {}) { const value = new OptionBuilder(OptionType.Attachment, name, description); configure(value); return this.option(value); }
  subcommand(name, description, configure = () => {}) {
    const value = new CommandBuilder(name, description, OptionType.Subcommand);
    configure(value);
    return this.option(value);
  }
  subcommandGroup(name, description, configure = () => {}) {
    const value = new CommandBuilder(name, description, OptionType.SubcommandGroup);
    configure(value);
    return this.option(value);
  }
  nameLocalizations(value) { this.data.name_localizations = copyObject(value, 'name localizations'); return this; }
  descriptionLocalizations(value) { this.data.description_localizations = copyObject(value, 'description localizations'); return this; }
  defaultMemberPermissions(value) { this.data.default_member_permissions = value === null ? null : String(value); return this; }
  dmPermission(value = true) { this.data.dm_permission = Boolean(value); return this; }
  nsfw(value = true) { this.data.nsfw = Boolean(value); return this; }
  contexts(value) { this.data.contexts = [...value]; return this; }
  integrationTypes(value) { this.data.integration_types = [...value]; return this; }
  toJSON() { return { ...this.data, ...(this.options.length ? { options: this.options.map(option => option.toJSON ? option.toJSON() : option) } : {}) }; }
}

export const command = (name, description) => new CommandBuilder(name, description);
export const userCommand = name => ({ name: requiredString(name, 'name'), type: CommandType.User });
export const messageCommand = name => ({ name: requiredString(name, 'name'), type: CommandType.Message });
export const option = (type, name, description) => new OptionBuilder(type, name, description);

export const response = Object.freeze({
  pong: () => ({ type: 1 }),
  message: (content, options = {}) => ({ type: 4, data: { content, ...options } }),
  defer: (ephemeral = false) => ({ type: 5, ...(ephemeral ? { data: { flags: 64 } } : {}) }),
  deferUpdate: () => ({ type: 6 }),
  update: (message, options = {}) => ({ type: 7, data: { ...(typeof message === 'string' ? { content: message } : message), ...options } }),
  autocomplete: choices => ({ type: 8, data: { choices } }),
  modal: (customId, title, components) => ({ type: 9, data: { custom_id: customId, title, components } }),
});

export function button(customId, label, style = 1, options = {}) {
  return { type: ComponentType.Button, custom_id: customId, label, style, ...options };
}
export function select(customId, options = [], placeholder, extra = {}) {
  return { type: ComponentType.StringSelect, custom_id: customId, options, ...(placeholder ? { placeholder } : {}), ...extra };
}
export function userSelect(customId, placeholder, options = {}) { return { type: ComponentType.UserSelect, custom_id: customId, ...(placeholder ? { placeholder } : {}), ...options }; }
export function roleSelect(customId, placeholder, options = {}) { return { type: ComponentType.RoleSelect, custom_id: customId, ...(placeholder ? { placeholder } : {}), ...options }; }
export function mentionableSelect(customId, placeholder, options = {}) { return { type: ComponentType.MentionableSelect, custom_id: customId, ...(placeholder ? { placeholder } : {}), ...options }; }
export function channelSelect(customId, placeholder, options = {}) { return { type: ComponentType.ChannelSelect, custom_id: customId, ...(placeholder ? { placeholder } : {}), ...options }; }
export function textInput(customId, label, style = 1, options = {}) { return { type: ComponentType.TextInput, custom_id: customId, label, style, ...options }; }
export function row(...components) { return { type: ComponentType.ActionRow, components }; }
