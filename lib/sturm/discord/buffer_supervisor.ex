defmodule Sturm.Discord.BufferSupervisor do
  @moduledoc """
  Dynamic supervisor for per-channel message buffers.
  """

  use DynamicSupervisor

  alias Sturm.Discord.ChannelBuffer

  def start_link(init_arg),
    do: DynamicSupervisor.start_link(__MODULE__, init_arg, name: __MODULE__)

  @impl true
  def init(_arg) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end

  def start_buffer(channel_id) do
    child = {ChannelBuffer, channel_id}
    DynamicSupervisor.start_child(__MODULE__, child)
  end
end
