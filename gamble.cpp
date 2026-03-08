#include <vector>
#include <algorithm>
// -- SECTION: GAMBLE_COMMAND ---------------------------------------------------
// gamble.cpp — #included by reactor.cpp after sendToBot(), memoryGet(), memorySet()

void handleGamble(const std::string& username, const std::string& args, const std::string& channel) {
    auto memGet = [&](const std::string& k) -> std::string { return memoryGet(k); };
    auto memSet = [&](const std::string& k, const std::string& v) { memorySet(k, v); };

    auto sendToChat = [&](const std::string& msg) {
        WSADATA wsa;
        WSAStartup(MAKEWORD(2,2), &wsa);
        SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a;
        a.sin_family = AF_INET;
        a.sin_port = htons(9001);
        a.sin_addr.s_addr = inet_addr("127.0.0.1");
        connect(s, (sockaddr*)&a, sizeof(a));
        send(s, msg.c_str(), msg.size(), 0);
        closesocket(s);
        WSACleanup();
    };

    auto getCash = [&](const std::string& user) -> long long {
        std::string val = memGet("cash_" + user);
        if (val.empty()) { memSet("cash_" + user, "25"); return 25; }
        return std::stoll(val);
    };
    auto setCash = [&](const std::string& user, long long amount) {
        memSet("cash_" + user, std::to_string(amount));
    };

    // ---- PARSE ARGS ----
    std::string sub = "";
    std::string arg1 = "";
    std::string arg2 = "";
    std::istringstream argStream(args);
    argStream >> sub >> arg1 >> arg2;

    srand((unsigned int)time(nullptr) ^ (unsigned int)(uintptr_t)&sub);

    // ---- COINFLIP ----
    if (sub == "coinflip" || sub == "cf") {
        if (arg1.empty()) {
            sendToChat("@" + username + " usage: !gamble coinflip <amount>");
        } else {
            long long bet = std::stoll(arg1);
            long long cash = getCash(username);
            if (bet <= 0) {
                sendToChat("@" + username + " invalid amount.");
            } else if (bet > cash) {
                sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash. You have $" + std::to_string(cash));
            } else {
                bool win = (rand() % 2) == 0;
                if (win) {
                    setCash(username, cash + bet);
                    sendToChat("@" + username + " \xE2\x9C\x85 won $" + std::to_string(bet) + "! \xF0\x9F\x92\xB5 $" + std::to_string(cash + bet));
                } else {
                    setCash(username, cash - bet);
                    sendToChat("@" + username + " \xE2\x9D\x8C lost $" + std::to_string(bet) + ". \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
                }
            }
        }
    }

    // ---- SLOTS ----
    else if (sub == "slots" || sub == "slot") {
        long long cash = getCash(username);
        long long bet = arg1.empty() ? std::max(1LL, cash / 10) : std::stoll(arg1);
        if (bet <= 0) {
            sendToChat("@" + username + " invalid amount.");
        } else if (bet > cash) {
            sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash. You have $" + std::to_string(cash));
        } else {
            sendToChat("@" + username + " \xF0\x9F\x8E\xB0 Spinning...");
            Sleep(3000);

            std::vector<std::string> symbols = {
                "\xF0\x9F\x8D\x92",             // cherry
                "\xF0\x9F\x8D\x8B",             // lemon
                "\xF0\x9F\x8D\x8A",             // orange
                "\xF0\x9F\x8D\x87",             // grape
                "\xE2\xAD\x90",                 // star
                "\xF0\x9F\x92\x8E",             // diamond
                "\x37\xEF\xB8\x8F\xE2\x83\xA3" // seven
            };

            auto rollReel = [&]() -> int {
                int r = rand() % 18;
                if (r < 3)  return 0;
                if (r < 6)  return 1;
                if (r < 9)  return 2;
                if (r < 12) return 3;
                if (r < 15) return 4;
                if (r < 17) return 5;
                return 6;
            };

            int r1 = rollReel();
            int r2 = rollReel();
            int r3 = rollReel();

            std::string display = "\xF0\x9F\x8E\xB0 [ " + symbols[r1] + " | " + symbols[r2] + " | " + symbols[r3] + " ] ";

            long long payout = 0;
            std::string resultMsg = "";

            if (r1 == r2 && r2 == r3) {
                if (r3 == 6)      { payout = bet * 10; resultMsg = "JACKPOT!! \xF0\x9F\x92\x8E"; }
                else if (r3 == 5) { payout = bet * 7;  resultMsg = "DIAMONDS!! \xF0\x9F\x92\x8E\xF0\x9F\x92\x8E\xF0\x9F\x92\x8E"; }
                else if (r3 == 4) { payout = bet * 4;  resultMsg = "Stars!! \xE2\xAD\x90\xE2\xAD\x90\xE2\xAD\x90"; }
                else              { payout = bet * 3;  resultMsg = "Three of a kind!"; }
                setCash(username, cash + payout);
                sendToChat(display + resultMsg + " +$" + std::to_string(payout) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash + payout));
            } else if (r1 == r2 || r2 == r3 || r1 == r3) {
                setCash(username, cash);
                sendToChat(display + "Two of a kind \xe2\x80\x94 bet returned. \xF0\x9F\x92\xB5 $" + std::to_string(cash));
            } else {
                setCash(username, cash - bet);
                sendToChat(display + "\xE2\x9D\x8C lost $" + std::to_string(bet) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
            }
        }
    }

    // ---- ROULETTE ----
    else if (sub == "roulette" || sub == "rl") {
        if (arg1.empty() || arg2.empty()) {
            sendToChat("@" + username + " usage: !gamble roulette <amount> <red|black|green>");
        } else {
            long long bet = std::stoll(arg1);
            long long cash = getCash(username);
            if (bet <= 0) {
                sendToChat("@" + username + " invalid amount.");
            } else if (bet > cash) {
                sendToChat("@" + username + " not enough \xF0\x9F\x92\xB5 cash. You have $" + std::to_string(cash));
            } else {
                int spin = rand() % 37;
                std::vector<int> reds = {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36};
                bool isRed   = std::find(reds.begin(), reds.end(), spin) != reds.end();
                bool isGreen = (spin == 0);
                bool isBlack = !isRed && !isGreen;

                std::string color = isGreen ? "\xF0\x9F\x9F\xA2 Green" : (isRed ? "\xF0\x9F\x94\xB4 Red" : "\xE2\x9A\xAB Black");
                std::string spinStr = color + " " + std::to_string(spin);

                bool win = false;
                long long payout = 0;
                if (arg2 == "red"   && isRed)   { win = true; payout = bet; }
                else if (arg2 == "black" && isBlack) { win = true; payout = bet; }
                else if (arg2 == "green" && isGreen) { win = true; payout = bet * 14; }

                if (win) {
                    setCash(username, cash + payout);
                    sendToChat("@" + username + " " + spinStr + " \xE2\x9C\x85 won $" + std::to_string(payout) + "! \xF0\x9F\x92\xB5 $" + std::to_string(cash + payout));
                } else {
                    setCash(username, cash - bet);
                    sendToChat("@" + username + " " + spinStr + " \xE2\x9D\x8C lost $" + std::to_string(bet) + ". \xF0\x9F\x92\xB5 $" + std::to_string(cash - bet));
                }
            }
        }
    }

    // ---- HELP ----
    else {
        sendToChat("@" + username + " \xF0\x9F\x8E\xB0 !gamble coinflip <amt> | slots <amt> | roulette <amt> <red|black|green> " + std::to_string(rand() % 10));
    }
}