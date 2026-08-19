//+------------------------------------------------------------------+
//|                                          MT5SignalListener.mq5  |
//|                        Script that loops and listens to pipe      |
//+------------------------------------------------------------------+
#property script_show_inputs
#property strict

input string PipeName = "MT5Signal";
input double LotSize = 0.01;
input double Slippage = 50;
input int    PollIntervalMs = 100;
input int    PositionWatchPollMs = 1000;

string   pipePath;
int      pipeHandle = INVALID_HANDLE;
string   messageBuffer = "";
string   trackedPositionComments[];
bool     trackedPositionKnown[];
string   trackedPendingComments[];
bool     trackedPendingKnown[];
datetime lastPositionScan = 0;
datetime lastPendingScan = 0;
datetime lastPipeHealthCheck = 0;
const int    PipeHealthCheckSec = 15;

//+------------------------------------------------------------------+
void OnStart()
  {
   pipePath = "\\\\.\\pipe\\" + PipeName;

   int i = 1;
   do
     {
      pipeHandle = FileOpen(pipePath, FILE_READ | FILE_WRITE | FILE_BIN | FILE_COMMON);
      if(pipeHandle != INVALID_HANDLE)
         break;
      int delay = MathMin(i, 10);
      Print("Attempt ", (string)i, " failed. Retrying after ", (string)delay, " seconds...");
      i++;
      Sleep(delay * 1000);
     }
   while(pipeHandle == INVALID_HANDLE);

   if(pipeHandle == INVALID_HANDLE)
     {
      Print("Failed to connect to Listener. Is the main.js running?");
      return;
     }

   Print("Connected to Listener");
   Print("Listening for signals... (Remove script from chart to stop)");

   while(!IsStopped())
     {
      // ─── Pipe health check ───
      if(TimeCurrent() - lastPipeHealthCheck >= PipeHealthCheckSec)
        {
         lastPipeHealthCheck = TimeCurrent();

         // Probe pipe health through existing handle
         if(FileWriteString(pipeHandle, "{\"action\":\"Ping\"}\n") == 0)
           {
            Print("Pipe health check failed — reconnecting...");
            int i = 1;
            do
              {
               pipeHandle = FileOpen(pipePath, FILE_READ | FILE_WRITE | FILE_BIN | FILE_COMMON);
               if(pipeHandle != INVALID_HANDLE)
                  break;
               int delay = MathMin(i, 10);
               Print("Reconnect attempt ", (string)i, " failed. Retrying after ", (string)delay, " seconds...");
               i++;
               Sleep(delay * 1000);
              }
            while(pipeHandle == INVALID_HANDLE);

            if(pipeHandle != INVALID_HANDLE)
               Print("Reconnected to Listener");
            else
               Print("Failed to reconnect to Listener.");
           }
        }
      // ─────────────────────────

      WatchTrackedPositions();
      WatchTrackedPendingOrders();
      CheckPipe();
      Sleep(PollIntervalMs);
     }

   FileClose(pipeHandle);
   Print("Listener stopped.");
  }

//+------------------------------------------------------------------+
ENUM_ORDER_TYPE_FILLING GetFillingMode()
  {
   uint filling = (uint)SymbolInfoInteger(_Symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK)
      return ORDER_FILLING_FOK;
   if((filling & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)
      return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
  }

//+------------------------------------------------------------------+
void CheckPipe()
  {
   ulong avail = FileSize(pipeHandle);
   if(avail == 0)
      return;

   uchar bytes[];
   ArrayResize(bytes, (int)avail);
   uint read = FileReadArray(pipeHandle, bytes);
   if(read == 0)
      return;

   string chunk = CharArrayToString(bytes, 0, (int)read, CP_UTF8);
   messageBuffer += chunk;

// Process complete lines - look for newline delimiter
   int newlinePos;
   while((newlinePos = StringFind(messageBuffer, "\n")) != -1)
     {
      string line = StringSubstr(messageBuffer, 0, newlinePos);
      // Remove the processed part from buffer INCLUDING the newline
      messageBuffer = StringSubstr(messageBuffer, newlinePos + 1);

      // Trim trailing \r if present
      int lineLen = StringLen(line);
      if(lineLen > 0 && StringGetCharacter(line, lineLen - 1) == '\r')
         line = StringSubstr(line, 0, lineLen - 1);

      if(StringLen(line) > 0)
        {
         ProcessMessage(line);
        }
     }

// Prevent buffer from growing indefinitely if no newline is found
// Keep last 4096 chars in case a partial message is at the end
   int bufLen = StringLen(messageBuffer);
   if(bufLen > 4096)
     {
      messageBuffer = StringSubstr(messageBuffer, bufLen - 4096);
     }
  }

//+------------------------------------------------------------------+
void WatchTrackedPositions()
  {
   datetime now = TimeCurrent();
   if(lastPositionScan != 0 && (now - lastPositionScan) * 1000 < PositionWatchPollMs)
      return;

   lastPositionScan = now;

   RefreshTrackedPositions();

   int trackedCount = ArraySize(trackedPositionComments);
   for(int i = 0; i < trackedCount; i++)
     {
      if(!trackedPositionKnown[i])
         continue;

      string positionId = trackedPositionComments[i];
      if(!PositionExistsByComment(positionId))
        {
         trackedPositionKnown[i] = false;
         SendPositionClosedNotification(positionId, "closed by SL, TP or manually");
        }
     }
  }

//+------------------------------------------------------------------+
void RefreshTrackedPositions()
  {
   string currentComments[];
   int total = PositionsTotal();
   ArrayResize(currentComments, total);

   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionSelectByTicket(ticket))
         currentComments[i] = PositionGetString(POSITION_COMMENT);
      else
         currentComments[i] = "";
     }

   for(int i = 0; i < total; i++)
     {
      string comment = currentComments[i];
      if(comment == "")
         continue;

      int knownIndex = FindTrackedPositionIndex(comment);
      if(knownIndex == -1)
        {
         int nextSize = ArraySize(trackedPositionComments) + 1;
         ArrayResize(trackedPositionComments, nextSize);
         ArrayResize(trackedPositionKnown, nextSize);
         trackedPositionComments[nextSize - 1] = comment;
         trackedPositionKnown[nextSize - 1] = true;
        }
      else
        {
         trackedPositionKnown[knownIndex] = true;
        }
     }
  }

//+------------------------------------------------------------------+ used in find tracked pos index
int FindTrackedPositionIndex(string positionId)
  {
   int total = ArraySize(trackedPositionComments);
   for(int i = 0; i < total; i++)
     {
      if(trackedPositionComments[i] == positionId)
         return i;
     }
   return -1;
  }

//+------------------------------------------------------------------+ used in watch tracked positions for position delete.
bool PositionExistsByComment(string positionId)
  {
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionSelectByTicket(ticket))
        {
         string comment = PositionGetString(POSITION_COMMENT);
         if(comment == positionId)
            return true;
        }
     }
   return false;
  }

//+------------------------------------------------------------------+
void WatchTrackedPendingOrders()
  {
   datetime now = TimeCurrent();
   if(lastPendingScan != 0 && (now - lastPendingScan) * 1000 < PositionWatchPollMs)
      return;

   lastPendingScan = now;

   RefreshTrackedPendingOrders();

   int trackedCount = ArraySize(trackedPendingComments);
   for(int i = 0; i < trackedCount; i++)
     {
      if(!trackedPendingKnown[i])
         continue;

      string positionId = trackedPendingComments[i];
      if(!PendingOrderExistsByComment(positionId))
        {
         trackedPendingKnown[i] = false;

         // The resting order is gone. If a position with the same comment
         // now exists, it filled — that's not a removal, WatchTrackedPositions
         // already covers it going forward. Otherwise it was cancelled,
         // expired, or rejected without ever filling.
         if(!PositionExistsByComment(positionId))
            SendPendingOrderRemovedNotification(positionId, "cancelled, expired, or rejected");
        }
     }
  }

//+------------------------------------------------------------------+
void RefreshTrackedPendingOrders()
  {
   string currentComments[];
   int total = OrdersTotal();
   ArrayResize(currentComments, total);

   for(int i = 0; i < total; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0)
         currentComments[i] = OrderGetString(ORDER_COMMENT);
      else
         currentComments[i] = "";
     }

   for(int i = 0; i < total; i++)
     {
      string comment = currentComments[i];
      if(comment == "")
         continue;

      int knownIndex = FindTrackedPendingIndex(comment);
      if(knownIndex == -1)
        {
         int nextSize = ArraySize(trackedPendingComments) + 1;
         ArrayResize(trackedPendingComments, nextSize);
         ArrayResize(trackedPendingKnown, nextSize);
         trackedPendingComments[nextSize - 1] = comment;
         trackedPendingKnown[nextSize - 1] = true;
        }
      else
        {
         trackedPendingKnown[knownIndex] = true;
        }
     }
  }

//+------------------------------------------------------------------+
int FindTrackedPendingIndex(string positionId)
  {
   int total = ArraySize(trackedPendingComments);
   for(int i = 0; i < total; i++)
     {
      if(trackedPendingComments[i] == positionId)
         return i;
     }
   return -1;
  }

//+------------------------------------------------------------------+
bool PendingOrderExistsByComment(string positionId)
  {
   int total = OrdersTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0 && OrderGetString(ORDER_COMMENT) == positionId)
         return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
void SendPendingOrderRemovedNotification(string positionId, string reason)
  {
   if(pipeHandle == INVALID_HANDLE)
      return;

   string payload = "{\"action\":\"PendingOrderRemoved\",\"positionId\":\"" + positionId + "\",\"reason\":\"" + reason + "\"}\n";
   uchar bytes[];
   StringToCharArray(payload, bytes, 0, WHOLE_ARRAY, CP_UTF8);

   if(FileWriteArray(pipeHandle, bytes, 0, ArraySize(bytes)) == 0)
      Print("Failed to send pending-removed notification for ", positionId);
   else
      Print("Sent pending-removed notification for ", positionId, " reason: ", reason);
  }

//+------------------------------------------------------------------+
void SendPositionClosedNotification(string positionId, string reason)
  {
   if(pipeHandle == INVALID_HANDLE)
      return;

   string payload = "{\"action\":\"PositionClosed\",\"positionId\":\"" + positionId + "\",\"reason\":\"" + reason + "\"}\n";
   uchar bytes[];
   StringToCharArray(payload, bytes, 0, WHOLE_ARRAY, CP_UTF8);

   if(FileWriteArray(pipeHandle, bytes, 0, ArraySize(bytes)) == 0)
      Print("Failed to send close notification for ", positionId);
   else
      Print("Sent close notification for ", positionId, " reason: ", reason);
  }

//+------------------------------------------------------------------+ maps signal "type" strings to MQL5 order types
int MapOrderType(string type)
  {
   if(type == "BUY")        return ORDER_TYPE_BUY;
   if(type == "SELL")       return ORDER_TYPE_SELL;
   if(type == "BUYLIMIT")   return ORDER_TYPE_BUY_LIMIT;
   if(type == "SELLLIMIT")  return ORDER_TYPE_SELL_LIMIT;
   if(type == "BUYSTOP")    return ORDER_TYPE_BUY_STOP;
   if(type == "SELLSTOP")   return ORDER_TYPE_SELL_STOP;
   return -1;
  }

//+------------------------------------------------------------------+
bool IsPendingOrderType(ENUM_ORDER_TYPE orderType)
  {
   return orderType == ORDER_TYPE_BUY_LIMIT || orderType == ORDER_TYPE_SELL_LIMIT ||
          orderType == ORDER_TYPE_BUY_STOP  || orderType == ORDER_TYPE_SELL_STOP;
  }

//+------------------------------------------------------------------+
void ProcessMessage(string message)
  {
   string action = ExtractJsonString(message, "action");
   string type = ExtractJsonString(message, "type");
   string positionId = ExtractJsonString(message, "positionId");
   double signalBid = ExtractJsonDouble(message, "bid");
   double signalPrice = ExtractJsonDouble(message, "price");
   double tp = ExtractJsonDouble(message, "tp");
   double sl = ExtractJsonDouble(message, "sl");

   bool actionNeedsOrderType = (action == "OpenPosition");
   int orderTypeValue = MapOrderType(type);

   if(actionNeedsOrderType && orderTypeValue == -1)
     {
      Print("Unknown or missing order type: ", type);
      return;
     }

   ENUM_ORDER_TYPE orderType = (ENUM_ORDER_TYPE)orderTypeValue;
   bool isPending = actionNeedsOrderType && IsPendingOrderType(orderType);

   double price = 0;
   if(actionNeedsOrderType)
     {
      if(isPending)
        {
         if(signalPrice <= 0)
           {
            Print("Pending order requires a valid 'price' field, skipping");
            return;
           }
         price = signalPrice;
        }
      else
        {
         if(signalBid > 0)
            price = signalBid;
         else
            price = (orderType == ORDER_TYPE_BUY)
                    ? SymbolInfoDouble(_Symbol, SYMBOL_ASK)
                    : SymbolInfoDouble(_Symbol, SYMBOL_BID);
        }
     }

   Print("Action: ", action, " | ID: [", positionId, "] | TP: ", tp, " | SL: ", sl);

   if(action == "OpenPosition")
     {
      if(tp <= 0 || sl <= 0)
        {
         Print("Invalid TP/SL values, skipping");
         return;
        }
      OpenPosition(orderType, price, tp, sl, positionId);
     }
   else
      if(action == "UpdatePosition")
         UpdatePosition(positionId, tp, sl);
      else
         if(action == "ClosePosition")
            ClosePosition(positionId);
         else
            if(action == "ModifyPending")
               ModifyPendingOrder(positionId, signalPrice, tp, sl);
            else
               if(action == "CancelPending")
                  CancelPendingOrder(positionId);
  }

//+------------------------------------------------------------------+
void OpenPosition(ENUM_ORDER_TYPE orderType, double price, double tp, double sl, string positionId)
  {
   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   int stopLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minDistance = stopLevel * point;

   bool isBuyDirection = (orderType == ORDER_TYPE_BUY || orderType == ORDER_TYPE_BUY_LIMIT || orderType == ORDER_TYPE_BUY_STOP);
   bool isPending = IsPendingOrderType(orderType);

   if(isBuyDirection)
     {
      if(sl >= price - minDistance)
        {
         Print("INVALID: SL(", sl, ") too close to entry price(", price, "). Min distance: ", minDistance);
         return;
        }
      if(tp <= price + minDistance)
        {
         Print("INVALID: TP(", tp, ") too close to entry price(", price, "). Min distance: ", minDistance);
         return;
        }
     }
   else
     {
      if(sl <= price + minDistance)
        {
         Print("INVALID: SL(", sl, ") too close to entry price(", price, "). Min distance: ", minDistance);
         return;
        }
      if(tp >= price - minDistance)
        {
         Print("INVALID: TP(", tp, ") too close to entry price(", price, "). Min distance: ", minDistance);
         return;
        }
     }

   request.action = isPending ? TRADE_ACTION_PENDING : TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = LotSize;
   request.type = orderType;
   request.price = price;
   request.sl = sl;
   request.tp = tp;
   request.deviation = (int)Slippage;
   request.comment = positionId;
   request.type_filling = GetFillingMode();
   if(isPending)
      request.type_time = ORDER_TIME_GTC;

   if(!OrderSend(request, result))
     {
      Print("OrderSend failed: ", result.retcode);
      return;
     }

   if(result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED)
      Print("SUCCESS! Ticket: ", result.order);
   else
      Print("Failed. Retcode: ", result.retcode);
  }

//+------------------------------------------------------------------+
void UpdatePosition(string positionId, double newTp, double newSl)
  {
   if(!PositionSelect(_Symbol))
     {
      Print("WARN: No position found for update");
      return;
     }

   ulong ticket = PositionGetTicket(0);
   string comment = PositionGetString(POSITION_COMMENT);

// quick check to index 0, its sometimes faster. and set up ticket and comment variables

   if(comment != positionId)
     {
      // Try to find position by iterating all positions
      int total = PositionsTotal();
      bool found = false;
      for(int i = 0; i < total; i++)
        {
         ticket = PositionGetTicket(i);
         comment = PositionGetString(POSITION_COMMENT);
         if(comment == positionId)
           {
            found = true;
            break;
           }
        }
      if(!found)
        {
         return;
        }
     }

   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   request.action = TRADE_ACTION_SLTP;
   request.position = ticket;
   request.tp = newTp;
   request.sl = newSl;

   if(!OrderSend(request, result))
     {
      Print("ERROR: UpdatePosition failed: ", result.retcode);
      return;
     }

   Print("SUCCESS! Updated position ", positionId, " - New TP: ", newTp, " SL: ", newSl);
  }

//+------------------------------------------------------------------+
void ClosePosition(string positionId)
  {
   if(!PositionSelect(_Symbol))
     {
      Print("No position found for close");
      return;
     }

   ulong ticket = PositionGetTicket(0);
   string comment = PositionGetString(POSITION_COMMENT);

   if(comment != positionId)
     {
      // Try to find position by iterating all positions
      int total = PositionsTotal();
      bool found = false;
      for(int i = 0; i < total; i++)
        {
         ticket = PositionGetTicket(i);
         comment = PositionGetString(POSITION_COMMENT);
         if(comment == positionId)
           {
            found = true;
            break;
           }
        }
      if(!found)
        {
         return;
        }
     }

   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   request.action = TRADE_ACTION_DEAL;
   request.position = ticket;
   request.symbol = _Symbol;
   request.volume = PositionGetDouble(POSITION_VOLUME);
   request.type = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
   request.price = (request.type == ORDER_TYPE_BUY) ? SymbolInfoDouble(_Symbol, SYMBOL_ASK) : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   request.deviation = (int)Slippage;
   request.type_filling = GetFillingMode();

   if(!OrderSend(request, result))
     {
      Print("ERROR: ClosePosition failed: ", result.retcode);
      return;
     }

   Print("SUCCESS! Closed position ", positionId, " Ticket: ", result.order);
  }

//+------------------------------------------------------------------+
bool FindPendingOrderByComment(string positionId, ulong &ticketOut)
  {
   int total = OrdersTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0)
         continue;
      if(OrderGetString(ORDER_COMMENT) == positionId)
        {
         ticketOut = ticket;
         return true;
        }
     }
   return false;
  }

//+------------------------------------------------------------------+
void ModifyPendingOrder(string positionId, double newPrice, double newTp, double newSl)
  {
   ulong ticket = 0;
   if(!FindPendingOrderByComment(positionId, ticket))
     {
      Print("WARN: No pending order found for ", positionId);
      return;
     }

   // Fall back to the order's existing values for any field the signal didn't provide
   double price = (newPrice > 0) ? newPrice : OrderGetDouble(ORDER_PRICE_OPEN);
   double tp    = (newTp    > 0) ? newTp    : OrderGetDouble(ORDER_TP);
   double sl    = (newSl    > 0) ? newSl    : OrderGetDouble(ORDER_SL);

   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   request.action = TRADE_ACTION_MODIFY;
   request.order = ticket;
   request.price = price;
   request.tp = tp;
   request.sl = sl;
   request.type_time = ORDER_TIME_GTC;

   if(!OrderSend(request, result))
     {
      Print("ERROR: ModifyPendingOrder failed: ", result.retcode);
      return;
     }

   Print("SUCCESS! Modified pending order ", positionId, " - Price: ", price, " TP: ", tp, " SL: ", sl);
  }

//+------------------------------------------------------------------+
void CancelPendingOrder(string positionId)
  {
   ulong ticket = 0;
   if(!FindPendingOrderByComment(positionId, ticket))
     {
      Print("WARN: No pending order found to cancel for ", positionId);
      return;
     }

   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   request.action = TRADE_ACTION_REMOVE;
   request.order = ticket;

   if(!OrderSend(request, result))
     {
      Print("ERROR: CancelPendingOrder failed: ", result.retcode);
      return;
     }

   Print("SUCCESS! Cancelled pending order ", positionId, " Ticket: ", ticket);
  }

//+------------------------------------------------------------------+ used in process message for pipes
double ExtractJsonDouble(string json, string key)
  {
   string search = "\"" + key + "\":";
   int pos = StringFind(json, search);
   if(pos == -1)
      return 0;

   int start = pos + StringLen(search);
   while(start < StringLen(json) && (json[start] == ' ' || json[start] == '\t'))
      start++;

   int end = start;
   while(end < StringLen(json))
     {
      ushort c = StringGetCharacter(json, end);
      if(c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' || c == '\r')
         break;
      end++;
     }

   string value = StringSubstr(json, start, end - start);
   value = StringTrim(value);
   return StringToDouble(value);
  }

//+------------------------------------------------------------------+ used in process message for pipes
string ExtractJsonString(string json, string key)
  {
   string search = "\"" + key + "\":";
   int pos = StringFind(json, search);
   if(pos == -1)
      return "";

   int start = pos + StringLen(search);
   while(start < StringLen(json) && (json[start] == ' ' || json[start] == '\t'))
      start++;

   if(StringGetCharacter(json, start) != '"')
      return "";
   start++;

   int end = start;
   while(end < StringLen(json))
     {
      ushort c = StringGetCharacter(json, end);
      // Check for unescaped closing quote
      if(c == '"' && StringGetCharacter(json, end - 1) != '\\')
         break;
      end++;
     }

   return StringSubstr(json, start, end - start);
  }

//+------------------------------------------------------------------+
string StringTrim(string str)
  {
   int len = StringLen(str);
   if(len == 0)
      return "";

   int start = 0;
   int end = len - 1;

   while(start < len)
     {
      ushort c = StringGetCharacter(str, start);
      if(c != ' ' && c != '\t' && c != '\n' && c != '\r' && c != '"')
         break;
      start++;
     }

   while(end >= 0)
     {
      ushort c = StringGetCharacter(str, end);
      if(c != ' ' && c != '\t' && c != '\n' && c != '\r' && c != '"')
         break;
      end--;
     }

   if(start > end)
      return "";
   return StringSubstr(str, start, end - start + 1);
  }
//+------------------------------------------------------------------+