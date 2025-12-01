import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/sturm start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :sturm, SturmWeb.Endpoint, server: true
end

config :sturm, SturmWeb.Endpoint, http: [port: String.to_integer(System.get_env("PORT", "4000"))]

discord_token = System.get_env("DISCORD_TOKEN")
discord_intents = System.get_env("DISCORD_INTENTS", "33281") |> String.to_integer()

discord_buffer_size =
  case System.get_env("DISCORD_BUFFER_SIZE") do
    nil ->
      40

    val ->
      case Integer.parse(val) do
        {i, _} -> i
        _ -> 40
      end
  end

if discord_token do
  config :sturm, :discord,
    token: discord_token,
    intents: discord_intents,
    buffer_size: discord_buffer_size
end

openai_api_key = System.get_env("OPENAI_API_KEY")

if openai_api_key do
  timeout_ms =
    case System.get_env("OPENAI_TIMEOUT_MS") do
      nil ->
        300_000

      val ->
        case Integer.parse(val) do
          {i, _} -> i
          _ -> 300_000
        end
    end

  judge_timeout_ms =
    case System.get_env("OPENAI_JUDGE_TIMEOUT_MS") do
      nil ->
        30_000

      val ->
        case Integer.parse(val) do
          {i, _} -> i
          _ -> 30_000
        end
    end

  config :sturm, :openai,
    api_key: openai_api_key,
    base_url: System.get_env("OPENAI_BASE_URL", "https://api.openai.com"),
    model: System.get_env("OPENAI_MODEL", "gpt-5-mini"),
    judge_model: System.get_env("OPENAI_JUDGE_MODEL", "gpt-5-nano"),
    reasoning: %{effort: System.get_env("OPENAI_REASONING_EFFORT", "low")},
    tools:
      System.get_env("OPENAI_TOOLS", "web_search,image_generation")
      |> String.split(",", trim: true)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == "")),
    timeout_ms: timeout_ms,
    judge_timeout_ms: judge_timeout_ms,
    system_prompt:
      System.get_env("OPENAI_SYSTEM_PROMPT") ||
        "You are %{bot_name}, a Discord bot participating in live channel conversations. Each message content you see is prefixed with [user NAME] for users and [assistant NAME] for the bot. Use the prefix to know who spoke. Reply only when explicitly mentioned; otherwise stay silent. When you reply, do NOT include any prefix—just the answer. Keep replies Discord-friendly: plain text or light markdown that renders well in Discord (no HTML). Be terse like Grok in Twitter threads: short, punchy, minimal markdown, no invented Discord commands.",
    judge_prompt:
      System.get_env("OPENAI_JUDGE_PROMPT") ||
        """
        You are a strict gatekeeper for Discord bot replies.
        The bot's name is: %{bot_name}
        Decide if the bot should respond to the latest message.
        Criteria: reply only when the latest message explicitly mentions the bot by that name or via a Discord mention and is seeking a reply.
        Output format: respond with one line, either "YES: <short reason>" or "NO: <short reason>".
        Do not add anything else.
        """
end

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise """
      environment variable DATABASE_URL is missing.
      For example: ecto://USER:PASS@HOST/DATABASE
      """

  maybe_ipv6 = if System.get_env("ECTO_IPV6") in ~w(true 1), do: [:inet6], else: []

  config :sturm, Sturm.Repo,
    # ssl: true,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10"),
    # For machines with several cores, consider starting multiple pools of `pool_size`
    # pool_count: 4,
    socket_options: maybe_ipv6

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  config :sturm, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :sturm, SturmWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      # See the documentation on https://hexdocs.pm/bandit/Bandit.html#t:options/0
      # for details about using IPv6 vs IPv4 and loopback vs public addresses.
      ip: {0, 0, 0, 0, 0, 0, 0, 0}
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :sturm, SturmWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://hexdocs.pm/plug/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :sturm, SturmWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.

  # ## Configuring the mailer
  #
  # In production you need to configure the mailer to use a different adapter.
  # Here is an example configuration for Mailgun:
  #
  #     config :sturm, Sturm.Mailer,
  #       adapter: Swoosh.Adapters.Mailgun,
  #       api_key: System.get_env("MAILGUN_API_KEY"),
  #       domain: System.get_env("MAILGUN_DOMAIN")
  #
  # Most non-SMTP adapters require an API client. Swoosh supports Req, Hackney,
  # and Finch out-of-the-box. This configuration is typically done at
  # compile-time in your config/prod.exs:
  #
  #     config :swoosh, :api_client, Swoosh.ApiClient.Req
  #
  # See https://hexdocs.pm/swoosh/Swoosh.html#module-installation for details.
end
