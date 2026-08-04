//+------------------------------------------------------------------+
//|                                          MT5SignalListener.mq5  |
//|                        Script that loops and listens to pipe      |
//+------------------------------------------------------------------+
#property script_show_inputs
#property strict

input string PipeName = "MT5Signal";
input double LotSize = 0.1;
input double Slippage = 50;
input int    PollIntervalMs = 100;
input int    PositionWatchPollMs = 1000;

string   pipePath;
int      pipeHandle = INVALID_HANDLE;
string   messageBuffer = "";
string   trackedPositionComments[];
bool     trackedPositionKnown[];
datetime lastPositionScan = 0;

//+------------------------------------------------------------------+
void OnStart()
  {
   pipePath = "\\\\.\\pipe\\" + PipeName;

   for(int i = 0; i < 10; i++)
     {
      pipeHandle = FileOpen(pipePath, FILE_READ | FILE_WRITE | FILE_BIN | FILE_COMMON);
      if(pipeHandle != INVALID_HANDLE)
         break;
      Print("Attempt ", i + 1, "/10 failed. Retrying...");
      Sleep(1000);
     }

   if(pipeHandle == INVALID_HANDLE)
     {
      Print("Failed to connect to pipe. Is Node.js running?");
      return;
     }

   Print("Connected to pipe: ", pipePath);
   Print("Listening for signals... (Remove script from chart to stop)");

   while(!IsStopped())
     {
      WatchTrackedPositions();
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
         Print("Received raw: ", line);
         ProcessMessage(line);
        }
     }
   
   // Prevent buffer from growing indefinitely if no newline is found
   // Keep last 4096 chars in case a partial message is at the end
   int bufLen = StringLen(messageBuffer);
   if(bufLen > 4096)
     {
      messageBuffer = StringSubstr(messageBuffer, bufLen - 4096);
      Print("WARN: Buffer trimmed to prevent overflow");
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
         SendPositionClosedNotification(positionId, "closed");
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
      if(PositionSelectByIndex(i))
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

//+------------------------------------------------------------------+
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

//+------------------------------------------------------------------+
bool PositionExistsByComment(string positionId)
  {
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      if(PositionSelectByIndex(i))
        {
         string comment = PositionGetString(POSITION_COMMENT);
         if(comment == positionId)
            return true;
        }
     }
   return false;
  }

//+------------------------------------------------------------------+
void SendPositionClosedNotification(string positionId, string reason)
  {
   if(pipeHandle == INVALID_HANDLE)
      return;

   string payload = "{\"action\":\"PositionClosed\",\"positionId\":\"" + positionId + "\",\"reason\":\"" + reason + "\"}\n";
   uchar bytes[];
   StringToCharArray(payload, bytes, 0, WHOLE_ARRAY, CP_UTF8);

   if(FileWriteArray(pipeHandle, bytes, 0, ArraySize(bytes)) < 0)
      Print("Failed to send close notification for ", positionId);
   else
      Print("Sent close notification for ", positionId, " reason: ", reason);
  }

//+------------------------------------------------------------------+
void ProcessMessage(string message)
  {
   string action = ExtractJsonString(message, "action");
   string type = ExtractJsonString(message, "type");
   string positionId = ExtractJsonString(message, "positionId");
   double signalBid = ExtractJsonDouble(message, "bid");
   double tp = ExtractJsonDouble(message, "tp");
   double sl = ExtractJsonDouble(message, "sl");

   Print("DEBUG Full JSON: ", message);
   Print("DEBUG Extracted positionId: [", positionId, "] Length: ", StringLen(positionId));

   ENUM_ORDER_TYPE orderType = (type == "BUY") ? ORDER_TYPE_BUY :
                               (type == "SELL") ? ORDER_TYPE_SELL : -1;

   if(orderType == -1 && action != "ClosePosition")
     {
      Print("Unknown type: ", type);
      return;
     }

   double price;
   if(signalBid > 0)
     {
      price = signalBid;
     }
   else
     {
      price = (orderType == ORDER_TYPE_BUY)
              ? SymbolInfoDouble(_Symbol, SYMBOL_ASK)
              : SymbolInfoDouble(_Symbol, SYMBOL_BID);
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
   else if(action == "UpdatePosition")
      UpdatePosition(positionId, tp, sl);
   else if(action == "ClosePosition")
      ClosePosition(positionId);
  }

//+------------------------------------------------------------------+
void OpenPosition(ENUM_ORDER_TYPE orderType, double price, double tp, double sl, string positionId)
  {
   MqlTradeRequest request = {};
   MqlTradeResult result = {};

   int stopLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double minDistance = stopLevel * point;

   if(orderType == ORDER_TYPE_BUY)
     {
      if(sl >= price - minDistance)
        {
         Print("INVALID: SL(", sl, ") too close to BUY price(", price, "). Min distance: ", minDistance);
         return;
        }
      if(tp <= price + minDistance)
        {
         Print("INVALID: TP(", tp, ") too close to BUY price(", price, "). Min distance: ", minDistance);
         return;
        }
     }
   else
     {
      if(sl <= price + minDistance)
        {
         Print("INVALID: SL(", sl, ") too close to SELL price(", price, "). Min distance: ", minDistance);
         return;
        }
      if(tp >= price - minDistance)
        {
         Print("INVALID: TP(", tp, ") too close to SELL price(", price, "). Min distance: ", minDistance);
         return;
        }
     }

   request.action = TRADE_ACTION_DEAL;
   request.symbol = _Symbol;
   request.volume = LotSize;
   request.type = orderType;
   request.price = price;
   request.sl = sl;
   request.tp = tp;
   request.deviation = (int)Slippage;
   request.comment = positionId;
   request.type_filling = GetFillingMode();

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
      Print("No position found for update");
      return;
     }

   ulong ticket = PositionGetTicket(0);
   string comment = PositionGetString(POSITION_COMMENT);

   Print("UPDATE DEBUG - Looking for: [", positionId, "] Got: [", comment, "]");

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
         Print("Position ID mismatch. Expected: [", positionId, "] Got: [", comment, "]");
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
      Print("UpdatePosition failed: ", result.retcode);
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
         Print("Position ID mismatch on close. Expected: [", positionId, "] Got: [", comment, "]");
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
      Print("ClosePosition failed: ", result.retcode);
      return;
     }

   Print("SUCCESS! Closed position ", positionId, " Ticket: ", result.order);
  }

//+------------------------------------------------------------------+
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

//+------------------------------------------------------------------+
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