defmodule Sturm.Discord.ChannelBuffer do
  @moduledoc """
  Bounded in-memory message buffer per channel for providing context to the bot.
  """

  use GenServer

  @type item :: %{
          role: String.t(),
          author_id: String.t(),
          author_name: String.t(),
          content: String.t(),
          message_id: String.t(),
          timestamp: String.t(),
          channel_id: String.t()
        }

  # Public API

  def start_link(channel_id) do
    GenServer.start_link(__MODULE__, channel_id, name: via(channel_id))
  end

  def append(channel_id, item) do
    ensure_started(channel_id)
    GenServer.call(via(channel_id), {:append, item})
  end

  def fetch(channel_id, opts \\ []) do
    ensure_started(channel_id)
    GenServer.call(via(channel_id), {:fetch, opts})
  end

  # Callbacks

  @impl true
  def init(channel_id) do
    {:ok,
     %{
       channel_id: channel_id,
       queue: :queue.new(),
       size: 0,
       capacity: capacity()
     }}
  end

  @impl true
  def handle_call({:append, item}, _from, state) do
    queue = :queue.in(item, state.queue)
    size = state.size + 1

    {queue, size} = maybe_trim(queue, size, state.capacity)
    {:reply, :ok, %{state | queue: queue, size: size}}
  end

  @impl true
  def handle_call({:fetch, opts}, _from, state) do
    limit = Keyword.get(opts, :limit, state.capacity)

    items =
      state.queue
      |> :queue.to_list()
      |> trim_from_end(limit)

    {:reply, items, state}
  end

  # Helpers

  defp capacity do
    Application.get_env(:sturm, :discord, [])
    |> Keyword.get(:buffer_size, 40)
  end

  defp maybe_trim(queue, size, capacity) when size <= capacity, do: {queue, size}

  defp maybe_trim(queue, size, capacity) do
    {{:value, _dropped}, queue} = :queue.out(queue)
    maybe_trim(queue, size - 1, capacity)
  end

  defp trim_from_end(list, limit) do
    list
    |> Enum.reverse()
    |> Enum.take(limit)
    |> Enum.reverse()
  end

  defp ensure_started(channel_id) do
    case Registry.lookup(Sturm.Discord.BufferRegistry, channel_id) do
      [] ->
        _ = Sturm.Discord.BufferSupervisor.start_buffer(channel_id)
        :ok

      _ ->
        :ok
    end
  end

  defp via(channel_id), do: {:via, Registry, {Sturm.Discord.BufferRegistry, channel_id}}
end
