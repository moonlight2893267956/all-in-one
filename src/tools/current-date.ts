import { z } from "zod";

type TimePrecision = "date" | "datetime" | "time" | "timestamp" | "iso";

const TIMEZONE_RE =
  /^[A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2}(?:\/[A-Za-z_+-]+)?$|^UTC$|^GMT$/;

function formatDate(date: Date, precision: TimePrecision, timezone: string): string {
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone };

  if (precision === "date" || precision === "datetime") {
    options.year = "numeric";
    options.month = "2-digit";
    options.day = "2-digit";
  }
  if (precision === "datetime") {
    options.hour = "2-digit";
    options.minute = "2-digit";
    options.second = "2-digit";
    options.hour12 = false;
  }
  if (precision === "time") {
    options.hour = "2-digit";
    options.minute = "2-digit";
    options.second = "2-digit";
    options.hour12 = false;
  }

  const parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  switch (precision) {
    case "date":
      return `${year}-${month}-${day}`;
    case "datetime":
      return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    case "time":
      return `${hour}:${minute}:${second}`;
    case "iso":
      return date.toISOString();
    case "timestamp":
      return String(date.getTime());
  }
}

const InputSchema = z.object({
  precision: z
    .enum(["date", "datetime", "time", "timestamp", "iso"])
    .default("datetime")
    .describe(
      "Output format: 'date' (YYYY-MM-DD), 'datetime' (YYYY-MM-DD HH:MM:SS), " +
        "'time' (HH:MM:SS), 'timestamp' (epoch ms), 'iso' (ISO 8601 UTC)"
    ),
  timezone: z
    .string()
    .default("Asia/Shanghai")
    .refine((tz) => TIMEZONE_RE.test(tz), {
      message:
        "Invalid timezone identifier. Use IANA names like 'Asia/Shanghai' or 'UTC'.",
    })
    .describe(
      "IANA timezone identifier (e.g. 'Asia/Shanghai', 'UTC', 'America/New_York'). " +
        "Only used for 'date', 'datetime', and 'time' precisions."
    ),
});

export const currentDateTool = {
  name: "current_date",
  description:
    "Get the current date and/or time, optionally in a specific timezone. " +
    "Use this when the user asks 'what's today's date', 'what time is it', " +
    "or needs the current timestamp. Returns the local time of the server " +
    "by default, configurable via the timezone parameter.",
  inputSchema: {
    type: "object" as const,
    properties: {
      precision: {
        type: "string",
        enum: ["date", "datetime", "time", "timestamp", "iso"],
        default: "datetime",
        description:
          "Output format: 'date' (YYYY-MM-DD), 'datetime' (YYYY-MM-DD HH:MM:SS), " +
          "'time' (HH:MM:SS), 'timestamp' (epoch ms), 'iso' (ISO 8601 UTC)",
      },
      timezone: {
        type: "string",
        default: "Asia/Shanghai",
        description:
          "IANA timezone identifier (e.g. 'Asia/Shanghai', 'UTC', 'America/New_York'). " +
          "Only used for 'date', 'datetime', and 'time' precisions.",
      },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = InputSchema.parse(args);
    const now = new Date();
    const value = formatDate(now, parsed.precision, parsed.timezone);

    const lines = [
      `Current ${parsed.precision}: ${value}`,
      `Timezone: ${parsed.timezone}`,
      `ISO 8601: ${now.toISOString()}`,
      `Timestamp: ${now.getTime()}`,
    ];

    return lines.join("\n");
  },
};
