using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Newtonsoft.Json;

namespace VRCX
{
    /// <summary>
    /// Minimal OSC (Open Sound Control) transport used by VRCX plugins to talk
    /// to VRChat. Sending covers the subset of the spec VRChat accepts
    /// (string/int/float/bool arguments); receiving decodes messages and
    /// bundles into a bounded queue that the UI polls.
    /// </summary>
    public partial class AppApi
    {
        private static readonly object _oscLock = new object();
        private static UdpClient _oscSendClient;
        private static UdpClient _oscReceiveClient;
        private static IPEndPoint _oscSendEndPoint;
        private static Thread _oscReceiveThread;
        private static volatile bool _oscReceiving;
        private static readonly ConcurrentQueue<OscReceivedMessage> _oscReceivedMessages = new ConcurrentQueue<OscReceivedMessage>();

        /// <summary>
        /// Caps the receive queue so a chatty avatar cannot grow memory without
        /// bound when nothing is polling.
        /// </summary>
        private const int OscReceiveQueueLimit = 512;

        private struct OscReceivedMessage
        {
            public string address { get; set; }
            public List<object> args { get; set; }
        }

        /// <summary>
        /// Opens the OSC send socket and, when <paramref name="receivePort"/> is
        /// greater than zero, starts listening for messages from VRChat.
        /// </summary>
        /// <param name="host">Destination host, normally 127.0.0.1.</param>
        /// <param name="sendPort">Destination port, normally 9000.</param>
        /// <param name="receivePort">Local listen port, normally 9001. Pass 0 to disable receiving.</param>
        /// <returns>True when the transport is ready.</returns>
        public bool OscStart(string host, int sendPort, int receivePort)
        {
            lock (_oscLock)
            {
                try
                {
                    OscStopInternal();

                    if (string.IsNullOrWhiteSpace(host))
                        host = "127.0.0.1";
                    if (sendPort <= 0 || sendPort > 65535)
                        sendPort = 9000;

                    if (!IPAddress.TryParse(host, out var address))
                    {
                        var entries = Dns.GetHostAddresses(host);
                        if (entries.Length == 0)
                            return false;
                        address = entries[0];
                    }

                    _oscSendEndPoint = new IPEndPoint(address, sendPort);
                    _oscSendClient = new UdpClient();

                    if (receivePort > 0 && receivePort <= 65535)
                    {
                        _oscReceiveClient = new UdpClient();
                        _oscReceiveClient.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                        _oscReceiveClient.Client.Bind(new IPEndPoint(IPAddress.Any, receivePort));
                        _oscReceiving = true;
                        _oscReceiveThread = new Thread(OscReceiveLoop)
                        {
                            IsBackground = true,
                            Name = "VRCX OSC Receive"
                        };
                        _oscReceiveThread.Start();
                    }

                    return true;
                }
                catch (Exception ex)
                {
                    logger.Error(ex, "Failed to start OSC transport");
                    OscStopInternal();
                    return false;
                }
            }
        }

        /// <summary>
        /// Closes both OSC sockets and drops any queued messages.
        /// </summary>
        public void OscStop()
        {
            lock (_oscLock)
            {
                OscStopInternal();
            }
        }

        private void OscStopInternal()
        {
            _oscReceiving = false;
            try
            {
                _oscReceiveClient?.Close();
            }
            catch
            {
                // socket already torn down
            }
            _oscReceiveClient = null;
            _oscReceiveThread = null;

            try
            {
                _oscSendClient?.Close();
            }
            catch
            {
                // socket already torn down
            }
            _oscSendClient = null;
            _oscSendEndPoint = null;

            while (_oscReceivedMessages.TryDequeue(out _))
            {
            }
        }

        /// <summary>
        /// True when the send socket is open.
        /// </summary>
        public bool OscIsRunning()
        {
            lock (_oscLock)
            {
                return _oscSendClient != null;
            }
        }

        /// <summary>
        /// Sends a string to the VRChat chatbox.
        /// </summary>
        /// <param name="text">Message body. VRChat truncates past 144 characters.</param>
        /// <param name="send">True to post immediately, false to place it in the keyboard buffer.</param>
        /// <param name="sound">True to play the notification sound.</param>
        public bool OscSendChatbox(string text, bool send, bool sound)
        {
            return OscSendRaw("/chatbox/input", new object[] { text ?? string.Empty, send, sound });
        }

        /// <summary>
        /// Toggles the chatbox typing indicator above the avatar.
        /// </summary>
        public bool OscSendTyping(bool typing)
        {
            return OscSendRaw("/chatbox/typing", new object[] { typing });
        }

        /// <summary>
        /// Sends a float avatar parameter, e.g. "MuteSelf".
        /// </summary>
        public bool OscSendFloat(string address, double value)
        {
            return OscSendRaw(address, new object[] { (float)value });
        }

        /// <summary>
        /// Sends an int avatar parameter.
        /// </summary>
        public bool OscSendInt(string address, int value)
        {
            return OscSendRaw(address, new object[] { value });
        }

        /// <summary>
        /// Sends a bool avatar parameter.
        /// </summary>
        public bool OscSendBool(string address, bool value)
        {
            return OscSendRaw(address, new object[] { value });
        }

        /// <summary>
        /// Drains messages received from VRChat since the last call.
        /// </summary>
        /// <returns>A JSON array of <c>{ address, args }</c> objects.</returns>
        public string OscPollMessages()
        {
            var batch = new List<OscReceivedMessage>();
            while (batch.Count < OscReceiveQueueLimit && _oscReceivedMessages.TryDequeue(out var message))
            {
                batch.Add(message);
            }
            return JsonConvert.SerializeObject(batch);
        }

        private bool OscSendRaw(string address, object[] args)
        {
            if (string.IsNullOrEmpty(address) || address[0] != '/')
                return false;

            UdpClient client;
            IPEndPoint endPoint;
            lock (_oscLock)
            {
                client = _oscSendClient;
                endPoint = _oscSendEndPoint;
            }
            if (client == null || endPoint == null)
                return false;

            try
            {
                var packet = EncodeOscMessage(address, args);
                client.Send(packet, packet.Length, endPoint);
                return true;
            }
            catch (Exception ex)
            {
                logger.Warn(ex, "Failed to send OSC message to {0}", address);
                return false;
            }
        }

        private static byte[] EncodeOscMessage(string address, object[] args)
        {
            var body = new List<byte>(128);
            body.AddRange(EncodeOscString(address));

            var typeTags = new StringBuilder(",");
            var payload = new List<byte>(64);
            foreach (var arg in args)
            {
                switch (arg)
                {
                    case bool boolValue:
                        typeTags.Append(boolValue ? 'T' : 'F');
                        break;
                    case int intValue:
                        typeTags.Append('i');
                        payload.AddRange(EncodeOscInt(intValue));
                        break;
                    case float floatValue:
                        typeTags.Append('f');
                        payload.AddRange(EncodeOscFloat(floatValue));
                        break;
                    case double doubleValue:
                        typeTags.Append('f');
                        payload.AddRange(EncodeOscFloat((float)doubleValue));
                        break;
                    default:
                        typeTags.Append('s');
                        payload.AddRange(EncodeOscString(Convert.ToString(arg, CultureInfo.InvariantCulture) ?? string.Empty));
                        break;
                }
            }

            body.AddRange(EncodeOscString(typeTags.ToString()));
            body.AddRange(payload);
            return body.ToArray();
        }

        private static byte[] EncodeOscString(string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            // OSC strings are null terminated and padded to a 4 byte boundary.
            var length = bytes.Length + 1;
            var padded = length % 4 == 0 ? length : length + (4 - (length % 4));
            var result = new byte[padded];
            Buffer.BlockCopy(bytes, 0, result, 0, bytes.Length);
            return result;
        }

        private static byte[] EncodeOscInt(int value)
        {
            var bytes = BitConverter.GetBytes(value);
            if (BitConverter.IsLittleEndian)
                Array.Reverse(bytes);
            return bytes;
        }

        private static byte[] EncodeOscFloat(float value)
        {
            var bytes = BitConverter.GetBytes(value);
            if (BitConverter.IsLittleEndian)
                Array.Reverse(bytes);
            return bytes;
        }

        private void OscReceiveLoop()
        {
            var remoteEndPoint = new IPEndPoint(IPAddress.Any, 0);
            while (_oscReceiving)
            {
                try
                {
                    var client = _oscReceiveClient;
                    if (client == null)
                        break;
                    var data = client.Receive(ref remoteEndPoint);
                    DecodeOscPacket(data, 0, data.Length);
                }
                catch (SocketException)
                {
                    // Socket closed while blocked in Receive during shutdown.
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    logger.Warn(ex, "Error while receiving OSC packet");
                }
            }
        }

        private void DecodeOscPacket(byte[] data, int offset, int length)
        {
            if (length <= 0)
                return;

            if (data[offset] == '#')
            {
                // Bundle: "#bundle" <timetag:8> [<size:4><element>]*
                var position = offset;
                if (!TryReadOscString(data, ref position, offset + length, out var marker) || marker != "#bundle")
                    return;
                position += 8; // skip the time tag, VRChat does not schedule
                while (position + 4 <= offset + length)
                {
                    var size = ReadOscInt(data, position);
                    position += 4;
                    if (size <= 0 || position + size > offset + length)
                        break;
                    DecodeOscPacket(data, position, size);
                    position += size;
                }
                return;
            }

            var cursor = offset;
            var end = offset + length;
            if (!TryReadOscString(data, ref cursor, end, out var address))
                return;
            if (!TryReadOscString(data, ref cursor, end, out var typeTags) || typeTags.Length == 0 || typeTags[0] != ',')
                return;

            var args = new List<object>(typeTags.Length - 1);
            for (var i = 1; i < typeTags.Length; i++)
            {
                switch (typeTags[i])
                {
                    case 'i':
                        if (cursor + 4 > end) return;
                        args.Add(ReadOscInt(data, cursor));
                        cursor += 4;
                        break;
                    case 'f':
                        if (cursor + 4 > end) return;
                        args.Add(ReadOscFloat(data, cursor));
                        cursor += 4;
                        break;
                    case 's':
                    case 'S':
                        if (!TryReadOscString(data, ref cursor, end, out var stringValue)) return;
                        args.Add(stringValue);
                        break;
                    case 'T':
                        args.Add(true);
                        break;
                    case 'F':
                        args.Add(false);
                        break;
                    case 'N':
                        args.Add(null);
                        break;
                    default:
                        // Unknown tag: the remaining payload can no longer be
                        // aligned, so stop rather than emit garbage.
                        i = typeTags.Length;
                        break;
                }
            }

            if (_oscReceivedMessages.Count >= OscReceiveQueueLimit)
                _oscReceivedMessages.TryDequeue(out _);

            _oscReceivedMessages.Enqueue(new OscReceivedMessage
            {
                address = address,
                args = args
            });
        }

        private static bool TryReadOscString(byte[] data, ref int position, int end, out string value)
        {
            value = null;
            var start = position;
            while (position < end && data[position] != 0)
                position++;
            if (position >= end)
                return false;
            value = Encoding.UTF8.GetString(data, start, position - start);
            var length = position - start + 1;
            var padded = length % 4 == 0 ? length : length + (4 - (length % 4));
            position = start + padded;
            return position <= end;
        }

        private static int ReadOscInt(byte[] data, int position)
        {
            return (data[position] << 24) | (data[position + 1] << 16) | (data[position + 2] << 8) | data[position + 3];
        }

        private static float ReadOscFloat(byte[] data, int position)
        {
            var bytes = new byte[4];
            Buffer.BlockCopy(data, position, bytes, 0, 4);
            if (BitConverter.IsLittleEndian)
                Array.Reverse(bytes);
            return BitConverter.ToSingle(bytes, 0);
        }
    }
}
